import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { CustomerArea } from '../areas/entities/customer-area.entity';
import { LocationMode } from '../settings/entities/app-settings.entity';
import { SettingsService } from '../settings/settings.service';
import {
  CreateLocationDto,
  ImportFlatAreasDto,
  ListLocationMembersQuery,
  UpdateLocationDto,
} from './dto/location.dto';
import { Location, LocationKind } from './entities/location.entity';
import { JORDAN, JORDAN_GOVERNORATES } from './jordan';

export interface LocationRow {
  id: string;
  parentId: string | null;
  kind: LocationKind;
  depth: number;
  code: string | null;
  nameAr: string;
  nameEn: string | null;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  /** Customers placed on this node itself (only areas hold customers). */
  customerCount: number;
  /** Customers anywhere under this node, itself included. */
  subtreeCustomerCount: number;
  /** The salesman set on this node itself. */
  repId: string | null;
  repName: string | null;
  /** The salesman it gets from above when it has none of its own. */
  inheritedRepId: string | null;
  inheritedRepName: string | null;
}

/** A node as it is stored — without the counts and names list() works out. */
type NodeView = Omit<LocationRow, 'customerCount' | 'subtreeCustomerCount' | 'repName' | 'inheritedRepId' | 'inheritedRepName'>;

/** One customer whose salesman a resolution changed. */
export interface RepMove {
  customerId: string;
  fromRepId: string | null;
  toRepId: string | null;
}

/** What assigning (or a dry run of assigning) a salesman does to customers. */
export interface RepChangeReport {
  dryRun: boolean;
  /** False in FLAT mode: the assignment is stored, but moves nobody until the switch to TREE. */
  applied: boolean;
  moved: number;
  /** Customers in scope assigned directly — they keep their salesman. */
  keptDirect: number;
  byRep: Array<{
    fromRepId: string | null;
    fromRepName: string | null;
    toRepId: string | null;
    toRepName: string | null;
    count: number;
  }>;
}

/** A customer rep_id that is "chosen", never overridden by an area: DIRECT, or a pre-column owner. */
const NOT_DIRECT = `(c.rep_source = 'AREA' OR c.rep_id IS NULL)`;

export interface LocationOption {
  id: string;
  kind: LocationKind;
  nameAr: string;
  nameEn: string | null;
  code: string | null;
  color: string | null;
  children: LocationOption[];
}

/** Where a customer's area sits, as a customer row carries it. */
export interface LocationLabel {
  locationId: string;
  locationName: string;
  governorateId: string | null;
  governorateName: string | null;
  governorateCode: string | null;
  /** "عمّان - الجبيهة" — governorate, then area. */
  locationLabel: string;
}

const CHILD_KIND: Record<LocationKind, LocationKind | null> = {
  COUNTRY: 'GOVERNORATE',
  GOVERNORATE: 'AREA',
  AREA: null,
};

/**
 * The location tree: one country, its governorates, and the areas customers
 * are placed in. A second way to say where a customer is, next to the flat
 * customer_areas list; app_settings.location_mode picks which one the
 * company uses. See docs/SPEC-location-tree.md.
 *
 * Every write that changes a customer's place tells the vans to re-pull (their
 * filter and labels follow the office) and, in TREE mode, re-sends the place
 * to the ERP, where it is the customer's address.
 */
@Injectable()
export class LocationTreeService {
  constructor(
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(CustomerArea) private readonly flatAreas: Repository<CustomerArea>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Reading the tree ────────────────────────────────────────────────────

  async list(includeInactive = true): Promise<{ items: LocationRow[]; total: number }> {
    const nodes = await this.allNodes();
    const own = await this.customerCountsByLocation();
    const subtree = new Map<string, number>();
    for (const n of nodes) {
      const count = own.get(n.id) ?? 0;
      if (!count) continue;
      for (const ancestorId of idsOnPath(n.path)) {
        subtree.set(ancestorId, (subtree.get(ancestorId) ?? 0) + count);
      }
    }
    const repNames = await this.repNames(nodes.map((n) => n.repId ?? '').filter(Boolean));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const items = nodes
      .filter((n) => includeInactive || n.isActive)
      .map((n) => {
        // The nearest node above with a salesman of its own.
        const above = idsOnPath(n.path)
          .slice(0, -1)
          .reverse()
          .map((id) => byId.get(id))
          .find((a) => a?.repId);
        return {
          ...this.toRow(n),
          customerCount: own.get(n.id) ?? 0,
          subtreeCustomerCount: subtree.get(n.id) ?? 0,
          repId: n.repId ?? null,
          repName: n.repId ? (repNames.get(n.repId) ?? null) : null,
          inheritedRepId: above?.repId ?? null,
          inheritedRepName: above?.repId ? (repNames.get(above.repId) ?? null) : null,
        };
      });
    return { items, total: items.length };
  }

  /** The places a salesman covers himself, with their customer counts — for his page. */
  async coveredBy(repId: string): Promise<Array<{ id: string; kind: LocationKind; label: string; customers: number }>> {
    const { items } = await this.list(true);
    const flat = items.map((i) => ({ ...i }));
    const byId = new Map(flat.map((i) => [i.id, i]));
    return flat
      .filter((n) => n.repId === repId)
      .map((n) => {
        const names: string[] = [];
        let cur: (typeof flat)[number] | undefined = n;
        while (cur) {
          if (cur.kind !== 'COUNTRY') names.unshift(cur.nameAr);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return { id: n.id, kind: n.kind, label: names.join(' - ') || n.nameAr, customers: n.subtreeCustomerCount };
      });
  }

  async getOne(id: string): Promise<Location> {
    const node = await this.locations.findOne({ where: { id } });
    if (!node) throw new NotFoundException('This location no longer exists. Refresh the locations list.');
    return node;
  }

  /** One node with the nodes above it, root first — for the detail panel's breadcrumb. */
  async getWithAncestors(id: string): Promise<NodeView & {
    ancestors: Array<{ id: string; kind: LocationKind; nameAr: string; nameEn: string | null }>;
  }> {
    const node = await this.getOne(id);
    const ancestorIds = idsOnPath(node.path).filter((a) => a !== id);
    const ancestors = ancestorIds.length
      ? await this.locations.find({ where: { id: In(ancestorIds) } })
      : [];
    ancestors.sort((a, b) => a.depth - b.depth);
    return {
      ...this.toRow(node),
      ancestors: ancestors.map((a) => ({ id: a.id, kind: a.kind, nameAr: a.nameAr, nameEn: a.nameEn ?? null })),
    };
  }

  /**
   * The active tree, nested, for a picker. A node under a deactivated parent
   * is left out with it: a rep must not file a shop under an area the office
   * has closed one level up.
   */
  async options(): Promise<LocationOption[]> {
    const nodes = (await this.allNodes()).filter((n) => n.isActive);
    const byParent = new Map<string | null, Location[]>();
    for (const n of nodes) {
      const key = n.parentId ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), n]);
    }
    const build = (parentId: string | null): LocationOption[] =>
      (byParent.get(parentId) ?? []).map((n) => ({
        id: n.id,
        kind: n.kind,
        nameAr: n.nameAr,
        nameEn: n.nameEn ?? null,
        code: n.code ?? null,
        color: n.color ?? null,
        children: build(n.id),
      }));
    return build(null);
  }

  /**
   * Every pickable area, flattened as "governorate - area". What the old flat
   * picker (GET /customers/areas) serves in TREE mode, so an app build that
   * only knows one row of areas still files shops into the tree.
   */
  async areaLeafOptions(): Promise<Array<{ id: string; nameAr: string; nameEn: string | null; color: string | null }>> {
    const out: Array<{ id: string; nameAr: string; nameEn: string | null; color: string | null }> = [];
    for (const country of await this.options()) {
      for (const gov of country.children) {
        for (const area of gov.children) {
          out.push({
            id: area.id,
            nameAr: `${gov.nameAr} - ${area.nameAr}`,
            nameEn: gov.nameEn && area.nameEn ? `${gov.nameEn} - ${area.nameEn}` : null,
            color: area.color,
          });
        }
      }
    }
    return out;
  }

  /** The place of each given area, for labelling customer rows. One query. */
  async labels(locationIds: string[]): Promise<Map<string, LocationLabel>> {
    const ids = [...new Set(locationIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows: Array<{
      id: string;
      name_ar: string;
      gov_id: string | null;
      gov_name: string | null;
      gov_code: string | null;
    }> = await this.locations.query(
      `SELECT a.id, a.name_ar, g.id AS gov_id, g.name_ar AS gov_name, g.code AS gov_code
         FROM locations a
         LEFT JOIN locations g ON g.id = a.parent_id AND g.kind = 'GOVERNORATE'
        WHERE a.id = ANY($1::uuid[]) AND a.deleted_at IS NULL`,
      [ids],
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          locationId: r.id,
          locationName: r.name_ar,
          governorateId: r.gov_id,
          governorateName: r.gov_name,
          governorateCode: r.gov_code,
          locationLabel: r.gov_name ? `${r.gov_name} - ${r.name_ar}` : r.name_ar,
        },
      ]),
    );
  }

  /** True when `id` is an AREA of the tree — how an old app's areaId is recognised in TREE mode. */
  async isArea(id: string): Promise<boolean> {
    return this.locations.exist({ where: { id, kind: 'AREA' } });
  }

  /**
   * An area a customer may be placed in: it exists, is an AREA, and it and
   * everything above it are active. The id comes from a picker this server
   * filled, so a miss means a stale list — refused rather than silently
   * saving the customer nowhere.
   */
  async assertAssignableArea(locationId: string | null | undefined): Promise<void> {
    if (!locationId) return;
    const node = await this.locations.findOne({ where: { id: locationId } });
    if (!node) {
      throw new BadRequestException(
        'The chosen area no longer exists. Refresh the locations list and choose again.',
      );
    }
    if (node.kind !== 'AREA') {
      throw new BadRequestException({
        code: 'LOCATION_NOT_AN_AREA',
        message: 'Choose an area, not a governorate or the country. Customers are placed in areas.',
      });
    }
    const chain = await this.locations.find({ where: { id: In(idsOnPath(node.path)) } });
    if (chain.some((n) => !n.isActive)) {
      throw new BadRequestException(
        'The chosen area, or its governorate, is deactivated. Choose another area, or activate it from the Locations page.',
      );
    }
  }

  /** The governorate code (JO-AM) above an area — what JoFotara takes as the buyer's city. */
  async governorateCodeOf(areaId: string): Promise<string | null> {
    const rows: Array<{ code: string | null }> = await this.locations.query(
      `SELECT g.code FROM locations a JOIN locations g ON g.id = a.parent_id
        WHERE a.id = $1 AND g.kind = 'GOVERNORATE'`,
      [areaId],
    );
    return rows[0]?.code ?? null;
  }

  // ── Writing the tree ────────────────────────────────────────────────────

  async create(dto: CreateLocationDto): Promise<Location> {
    const nameAr = dto.nameAr.trim();
    let kind: LocationKind;
    let parent: Location | null = null;
    if (!dto.parentId) {
      kind = 'COUNTRY';
      if (await this.locations.exist({ where: { parentId: IsNull() } })) {
        throw new ConflictException({
          code: 'LOCATION_ROOT_EXISTS',
          message: 'The tree already has a country at the top. Add governorates under it.',
        });
      }
    } else {
      parent = await this.getOne(dto.parentId);
      const child = CHILD_KIND[parent.kind];
      if (!child) {
        throw new BadRequestException({
          code: 'LOCATION_TOO_DEEP',
          message: 'An area cannot have places under it. Add the new place to a governorate.',
        });
      }
      kind = child;
    }
    const code = this.normaliseCode(kind, dto.code);
    await this.assertNameFree(parent?.id ?? null, nameAr);
    if (kind === 'GOVERNORATE' && code) await this.assertGovernorateCodeFree(code);

    const id = randomUUID();
    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder(parent?.id ?? null));
    return this.locations.save(
      this.locations.create({
        id,
        parentId: parent?.id ?? null,
        kind,
        path: `${parent?.path ?? '/'}${id}/`,
        depth: parent ? parent.depth + 1 : 0,
        code,
        nameAr,
        nameEn: dto.nameEn?.trim() || null,
        color: dto.color ?? null,
        sortOrder,
        isActive: dto.isActive ?? true,
      }),
    );
  }

  async update(id: string, dto: UpdateLocationDto): Promise<Location> {
    const node = await this.getOne(id);
    let placeChanged = false;

    if (dto.parentId !== undefined && dto.parentId !== node.parentId) {
      if (node.kind !== 'AREA') {
        throw new BadRequestException({
          code: 'LOCATION_CANNOT_MOVE',
          message: 'Only an area can be moved, to another governorate.',
        });
      }
      const target = await this.getOne(dto.parentId);
      if (target.kind !== 'GOVERNORATE') {
        throw new BadRequestException({
          code: 'LOCATION_CANNOT_MOVE',
          message: 'An area can only be moved under a governorate.',
        });
      }
      await this.assertNameFree(target.id, dto.nameAr?.trim() ?? node.nameAr, id);
      await this.movePath(node, target);
      placeChanged = true;
    }
    if (dto.nameAr !== undefined && dto.nameAr.trim() !== node.nameAr) {
      await this.assertNameFree(node.parentId ?? null, dto.nameAr, id);
      node.nameAr = dto.nameAr.trim();
      placeChanged = true;
    }
    if (dto.nameEn !== undefined) node.nameEn = dto.nameEn.trim() || null;
    if (dto.code !== undefined) {
      const code = this.normaliseCode(node.kind, dto.code);
      if (node.kind === 'GOVERNORATE' && code && code !== node.code) {
        await this.assertGovernorateCodeFree(code, id);
      }
      node.code = code;
    }
    if (dto.color !== undefined) node.color = dto.color;
    if (dto.sortOrder !== undefined) node.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) node.isActive = dto.isActive;

    const moved = dto.parentId !== undefined && placeChanged && node.parentId === dto.parentId;
    const saved = await this.locations.save(node);
    this.changed('location.updated');
    // A rename or a move changes the label every customer below carries — and
    // the address the ERP holds for them.
    if (placeChanged) await this.placeChanged(await this.customerIdsUnder(saved));
    // Moved under another governorate: its customers without a salesman of
    // their own follow the new governorate's.
    if (moved) await this.applyReps({ nodePath: saved.path });
    return saved;
  }

  /**
   * Delete a node — refused while anything hangs off it. Unlike a flat area,
   * deleting a place must not quietly leave customers in none: the office
   * moves them first, or deactivates the place instead.
   */
  async remove(id: string): Promise<void> {
    const node = await this.getOne(id);
    if (await this.locations.exist({ where: { parentId: id } })) {
      throw new ConflictException({
        code: 'LOCATION_HAS_CHILDREN',
        message: 'Remove or move the places under it first, or deactivate it instead.',
      });
    }
    if ((await this.customerIdsUnder(node)).length) {
      throw new ConflictException({
        code: 'LOCATION_HAS_CUSTOMERS',
        message: 'Customers are placed here. Move them to another area first, or deactivate it instead.',
      });
    }
    await this.locations.softDelete(id);
    this.changed('location.deleted');
  }

  async reorder(parentId: string | null, ids: string[]): Promise<{ reordered: number }> {
    const siblings = await this.locations.find({
      where: { parentId: parentId ?? IsNull() },
      select: { id: true },
    });
    const known = new Set(siblings.map((s) => s.id));
    if (ids.length !== known.size || ids.some((i) => !known.has(i))) {
      throw new BadRequestException(
        'The order must list every place under this parent exactly once. Refresh and try again.',
      );
    }
    await this.dataSource.transaction(async (m) => {
      for (const [i, id] of ids.entries()) await m.update(Location, { id }, { sortOrder: i });
    });
    this.changed('location.reordered');
    return { reordered: ids.length };
  }

  /**
   * Jordan and its twelve governorates, with the codes JoFotara takes. Run as
   * often as you like: what is already there (by code, or by name) is kept.
   * Areas are never seeded — every distributor names its own.
   */
  async seedJordan(): Promise<{ created: number; existing: number; countryId: string }> {
    let created = 0;
    let existing = 0;
    let root = await this.locations.findOne({ where: { parentId: IsNull() } });
    if (!root) {
      root = await this.create({ nameAr: JORDAN.nameAr, nameEn: JORDAN.nameEn, code: JORDAN.code });
      created += 1;
    } else {
      existing += 1;
    }
    const children = await this.locations.find({ where: { parentId: root.id } });
    for (const [i, gov] of JORDAN_GOVERNORATES.entries()) {
      const there = children.some((c) => c.code === gov.code || c.nameAr === gov.nameAr);
      if (there) {
        existing += 1;
        continue;
      }
      await this.create({ parentId: root.id, nameAr: gov.nameAr, nameEn: gov.nameEn, code: gov.code, sortOrder: i });
      created += 1;
    }
    if (created) this.changed('location.seeded');
    return { created, existing, countryId: root.id };
  }

  /**
   * Bring the flat areas into the tree: each mapped area becomes (or joins) an
   * area under its governorate, and its customers are placed there. Their
   * area_id is left as it is, so switching back to FLAT loses nothing.
   * Re-runnable — an area of the same name under that governorate is reused.
   */
  async importFlat(dto: ImportFlatAreasDto): Promise<{
    created: number;
    reused: number;
    customersPlaced: number;
    unmappedAreas: Array<{ id: string; nameAr: string; memberCount: number }>;
  }> {
    const govIds = [...new Set(dto.mapping.map((m) => m.governorateId))];
    const govs = await this.locations.find({ where: { id: In(govIds) } });
    const govById = new Map(govs.map((g) => [g.id, g]));
    for (const id of govIds) {
      const g = govById.get(id);
      if (!g || g.kind !== 'GOVERNORATE') {
        throw new BadRequestException('Each area must go under a governorate. Refresh the locations list and choose again.');
      }
    }
    const areaIds = [...new Set(dto.mapping.map((m) => m.areaId))];
    const flat = await this.flatAreas.find({ where: { id: In(areaIds) } });
    const flatById = new Map(flat.map((a) => [a.id, a]));
    if (flat.length !== areaIds.length) {
      throw new BadRequestException('Some of the chosen areas no longer exist. Refresh the areas list and choose again.');
    }

    let created = 0;
    let reused = 0;
    let customersPlaced = 0;
    const placed: string[] = [];
    await this.dataSource.transaction(async (m) => {
      for (const row of dto.mapping) {
        const area = flatById.get(row.areaId)!;
        const gov = govById.get(row.governorateId)!;
        let leaf = await m.findOne(Location, { where: { parentId: gov.id, nameAr: area.nameAr } });
        if (leaf) {
          reused += 1;
        } else {
          const id = randomUUID();
          leaf = await m.save(
            m.create(Location, {
              id,
              parentId: gov.id,
              kind: 'AREA',
              path: `${gov.path}${id}/`,
              depth: gov.depth + 1,
              nameAr: area.nameAr,
              nameEn: area.nameEn ?? null,
              color: area.color ?? null,
              sortOrder: await this.nextSortOrder(gov.id, m),
              isActive: area.isActive,
            }),
          );
          created += 1;
        }
        const rows: Array<{ id: string }> = await m.query(
          `UPDATE customers
              SET location_id = $1,
                  city_code = COALESCE(NULLIF(city_code, ''), $3),
                  updated_at = now(), version = version + 1
            WHERE area_id = $2 AND deleted_at IS NULL
          RETURNING id`,
          [leaf.id, area.id, gov.code ?? null],
        );
        // TypeORM hands an UPDATE … RETURNING back as [rows, rowCount].
        const ids = (Array.isArray(rows[0]) ? (rows[0] as unknown as Array<{ id: string }>) : rows).map((r) => r.id);
        customersPlaced += ids.length;
        placed.push(...ids);
      }
    });

    const unmapped: Array<{ id: string; name_ar: string; members: string }> = await this.flatAreas.query(
      `SELECT a.id, a.name_ar,
              (SELECT COUNT(*) FROM customers c WHERE c.area_id = a.id AND c.deleted_at IS NULL) AS members
         FROM customer_areas a
        WHERE a.deleted_at IS NULL AND NOT (a.id = ANY($1::uuid[]))
        ORDER BY a.name_ar`,
      [areaIds],
    );
    this.changed('location.imported');
    await this.placeChanged(placed);
    await this.applyReps({ customerIds: placed });
    return {
      created,
      reused,
      customersPlaced,
      unmappedAreas: unmapped.map((u) => ({ id: u.id, nameAr: u.name_ar, memberCount: Number(u.members) || 0 })),
    };
  }

  // ── Customers in an area ────────────────────────────────────────────────

  async members(
    id: string,
    q: ListLocationMembersQuery,
  ): Promise<{ items: Array<Customer & { repName: string | null; locationLabel: string | null }>; total: number }> {
    const node = await this.getOne(id);
    const qb = this.customers
      .createQueryBuilder('c')
      .where('c.deleted_at IS NULL')
      .orderBy('c.name_ar', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .take(q.limit ?? 50)
      .skip(q.offset ?? 0);
    if (q.subtree) {
      qb.andWhere(
        `c.location_id IN (SELECT l.id FROM locations l WHERE l.path LIKE :p AND l.deleted_at IS NULL)`,
        { p: `${node.path}%` },
      );
    } else {
      qb.andWhere('c.location_id = :id', { id });
    }
    if (q.q?.trim()) {
      qb.andWhere('(c.name_ar ILIKE :s OR c.customer_number ILIKE :s)', { s: `%${q.q.trim()}%` });
    }
    const [rows, total] = await qb.getManyAndCount();
    const repIds = [...new Set(rows.map((c) => c.repId).filter((r): r is string => !!r))];
    const reps: Array<{ id: string; name_ar: string; code: string | null }> = repIds.length
      ? await this.customers.query(`SELECT id, name_ar, code FROM reps WHERE id = ANY($1::uuid[])`, [repIds])
      : [];
    const repName = new Map(reps.map((r) => [r.id, r.code ? `${r.name_ar} (${r.code})` : r.name_ar]));
    const labels = await this.labels(rows.map((c) => c.locationId ?? '').filter(Boolean));
    const items = rows.map((c) =>
      Object.assign(c, {
        repName: c.repId ? (repName.get(c.repId) ?? null) : null,
        locationLabel: c.locationId ? (labels.get(c.locationId)?.locationLabel ?? null) : null,
      }),
    );
    return { items, total };
  }

  /** Place customers in this area. A customer has one area, so this replaces any other. */
  async addMembers(id: string, customerIds: string[]): Promise<{ moved: number }> {
    await this.assertAssignableArea(id);
    const found = await this.customers.count({ where: { id: In(customerIds), deletedAt: IsNull() } });
    if (found !== customerIds.length) {
      throw new BadRequestException(
        'Some of the chosen customers no longer exist. Refresh the list and choose again.',
      );
    }
    const code = await this.governorateCodeOf(id);
    await this.customers.query(
      `UPDATE customers
          SET location_id = $1,
              city_code = COALESCE(NULLIF(city_code, ''), $3),
              updated_at = now(), version = version + 1
        WHERE id = ANY($2::uuid[])`,
      [id, customerIds, code],
    );
    this.changed('location.members');
    await this.placeChanged(customerIds);
    await this.applyReps({ customerIds });
    return { moved: customerIds.length };
  }

  async removeMember(id: string, customerId: string): Promise<void> {
    await this.getOne(id);
    const res = await this.customers.update({ id: customerId, locationId: id }, { locationId: null });
    this.changed('location.members');
    if (res.affected) await this.placeChanged([customerId]);
  }

  // ── Mode ────────────────────────────────────────────────────────────────

  /**
   * Switch the company between the flat areas and the tree.
   *
   * Nothing is deleted either way: flat areas keep their members, tree nodes
   * keep theirs. Going to TREE is refused while the tree has no area — every
   * customer would suddenly show no place and the new-shop picker would be
   * empty. `dryRun` reports what the switch would show and changes nothing.
   */
  async switchMode(mode: LocationMode, dryRun = false): Promise<{
    from: LocationMode;
    mode: LocationMode;
    changed: boolean;
    dryRun: boolean;
    areas: number;
    customersPlaced: number;
    customersWithoutPlace: number;
    /** Going to TREE: customers whose salesman follows their area and changes. */
    reps: RepChangeReport;
  }> {
    const from = await this.settings.locationMode();
    const [counts] = (await this.locations.query(
      `SELECT
         (SELECT COUNT(*) FROM locations WHERE kind = 'AREA' AND deleted_at IS NULL AND is_active) AS areas,
         (SELECT COUNT(*) FROM customers WHERE deleted_at IS NULL AND location_id IS NOT NULL) AS tree_placed,
         (SELECT COUNT(*) FROM customers WHERE deleted_at IS NULL AND area_id IS NOT NULL) AS flat_placed,
         (SELECT COUNT(*) FROM customers WHERE deleted_at IS NULL) AS total`,
    )) as Array<{ areas: string; tree_placed: string; flat_placed: string; total: string }>;
    const areas = Number(counts.areas) || 0;
    const placedInTarget = Number(mode === 'TREE' ? counts.tree_placed : counts.flat_placed) || 0;
    const report = {
      from,
      mode,
      changed: from !== mode,
      dryRun,
      areas,
      customersPlaced: placedInTarget,
      customersWithoutPlace: (Number(counts.total) || 0) - placedInTarget,
      reps:
        mode === 'TREE' && from !== mode
          ? await this.report(await this.resolve({ all: true }, true), true, true, { all: true })
          : emptyReport(dryRun),
    };
    if (mode === 'TREE' && areas === 0) {
      throw new ConflictException({
        code: 'LOCATION_TREE_EMPTY',
        message: 'The location tree has no areas yet. Add governorates and areas, or import the current areas, before switching.',
      });
    }
    if (dryRun || from === mode) return report;

    await this.settings.setLocationMode(mode);
    // Every phone's labels, filter and picker change at once.
    this.changed('location.mode');
    // Area salesmen take effect: customers without a salesman of their own
    // follow their area's.
    if (mode === 'TREE') report.reps = await this.applyReps({ all: true });
    // The ERP holds the place as the customer's address; it now reads the other set.
    const rows: Array<{ id: string }> = await this.customers.query(
      `SELECT id FROM customers WHERE deleted_at IS NULL AND (location_id IS NOT NULL OR area_id IS NOT NULL)`,
    );
    if (rows.length) this.events.emit('erp.customer.area', { customerIds: rows.map((r) => r.id) });
    return report;
  }

  // ── Salesmen by area ────────────────────────────────────────────────────

  /**
   * Give a place a salesman, or take it away (`repId: null`). Every customer
   * below it without a salesman of their own (BE spec §5.1) follows: to this
   * salesman, or — when cleared — to the next one up, or to none.
   *
   * `dryRun` does the whole thing inside a transaction and rolls it back, so
   * the preview is exactly what the real run will do. In FLAT mode the
   * assignment is stored and moves nobody until the company switches to TREE.
   */
  async setRep(id: string, repId: string | null, dryRun = false): Promise<RepChangeReport> {
    const node = await this.getOne(id);
    if (repId) {
      const rows: Array<{ id: string }> = await this.locations.query(
        `SELECT id FROM reps WHERE id = $1 AND deleted_at IS NULL`,
        [repId],
      );
      if (!rows.length) throw new BadRequestException('That salesman no longer exists. Refresh and choose again.');
    }
    const tree = (await this.settings.locationMode()) === 'TREE';
    const scope = { nodePath: node.path };

    if (dryRun) {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.manager.update(Location, { id }, { repId });
        const moves = tree ? await this.resolve(scope, true, qr.manager) : [];
        return await this.report(moves, true, tree, scope, qr.manager);
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    }

    await this.locations.update({ id }, { repId });
    this.changed('location.rep');
    if (!tree) return this.report([], false, false, scope);
    return this.applyReps(scope);
  }

  /**
   * Re-resolve customers' salesmen from their areas, write the changes, and
   * tell the phones that lost or gained a shop. Only in TREE mode. Serialised
   * with an advisory lock so two office users cannot interleave.
   */
  async applyReps(scope: RepScope): Promise<RepChangeReport> {
    if ((await this.settings.locationMode()) !== 'TREE') return emptyReport(false);
    const moves = await this.dataSource.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('location-reps'))`);
      return this.resolve(scope, false, m);
    });
    this.notifyMoves(moves);
    return this.report(moves, false, true, scope);
  }

  /**
   * The salesman each customer in scope should have from its area — the
   * nearest node up its path that has one — compared with what it has.
   * Customers with a salesman of their own are left out. With `dryRun` only
   * reads; otherwise writes the changes in ONE statement and returns them.
   */
  private async resolve(scope: RepScope, dryRun: boolean, m?: EntityManager): Promise<RepMove[]> {
    const runner = m ?? this.dataSource.manager;
    const { where, params } = scopeWhere(scope);
    const target = `
      WITH target AS (
        SELECT c.id, c.rep_id AS old_rep,
               (SELECT a.rep_id FROM locations a
                 WHERE a.deleted_at IS NULL AND a.rep_id IS NOT NULL
                   AND l.path LIKE a.path || '%'
                 ORDER BY a.depth DESC LIMIT 1) AS new_rep
          FROM customers c
          JOIN locations l ON l.id = c.location_id AND l.deleted_at IS NULL
         WHERE c.deleted_at IS NULL AND ${NOT_DIRECT} AND ${where}
      )`;
    const rows: Array<{ id: string; old_rep: string | null; new_rep: string | null }> = dryRun
      ? await runner.query(`${target} SELECT id, old_rep, new_rep FROM target WHERE old_rep IS DISTINCT FROM new_rep`, params)
      : await runner.query(
          `${target},
           upd AS (
             UPDATE customers c
                SET rep_id = t.new_rep,
                    rep_source = CASE WHEN t.new_rep IS NULL THEN NULL ELSE 'AREA' END,
                    updated_at = now(), version = c.version + 1
               FROM target t
              WHERE c.id = t.id
                AND (c.rep_id IS DISTINCT FROM t.new_rep
                     OR c.rep_source IS DISTINCT FROM (CASE WHEN t.new_rep IS NULL THEN NULL ELSE 'AREA' END))
             RETURNING c.id, t.old_rep, t.new_rep
           )
           SELECT id, old_rep, new_rep FROM upd WHERE old_rep IS DISTINCT FROM new_rep`,
          params,
        );
    return rows.map((r) => ({ customerId: r.id, fromRepId: r.old_rep, toRepId: r.new_rep }));
  }

  /** One sync signal per salesman who lost or gained shops — not one per customer. */
  private notifyMoves(moves: RepMove[]): void {
    const reps = new Set<string>();
    for (const mv of moves) {
      if (mv.fromRepId) reps.add(mv.fromRepId);
      if (mv.toRepId) reps.add(mv.toRepId);
    }
    for (const repId of reps) this.events.emit('customer.changed', { repId, reason: 'location.rep' });
    if (moves.length) {
      this.events.emit('erp.customer.salesman', { customerIds: moves.map((mv) => mv.customerId) });
    }
  }

  private async report(
    moves: RepMove[],
    dryRun: boolean,
    applied: boolean,
    scope: RepScope,
    m?: EntityManager,
  ): Promise<RepChangeReport> {
    const runner = m ?? this.dataSource.manager;
    const { where, params } = scopeWhere(scope);
    const [kept] = (await runner.query(
      `SELECT COUNT(*) AS n FROM customers c
         JOIN locations l ON l.id = c.location_id AND l.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND NOT ${NOT_DIRECT} AND ${where}`,
      params,
    )) as Array<{ n: string }>;
    const groups = new Map<string, { fromRepId: string | null; toRepId: string | null; count: number }>();
    for (const mv of moves) {
      const key = `${mv.fromRepId ?? ''}>${mv.toRepId ?? ''}`;
      const g = groups.get(key) ?? { fromRepId: mv.fromRepId, toRepId: mv.toRepId, count: 0 };
      g.count += 1;
      groups.set(key, g);
    }
    const names = await this.repNames(moves.flatMap((mv) => [mv.fromRepId ?? '', mv.toRepId ?? '']).filter(Boolean));
    return {
      dryRun,
      applied,
      moved: moves.length,
      keptDirect: Number(kept?.n) || 0,
      byRep: [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .map((g) => ({
          ...g,
          fromRepName: g.fromRepId ? (names.get(g.fromRepId) ?? null) : null,
          toRepName: g.toRepId ? (names.get(g.toRepId) ?? null) : null,
        })),
    };
  }

  /** "أحمد (201)" by rep id. */
  private async repNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows: Array<{ id: string; name_ar: string; code: string | null }> = await this.locations.query(
      `SELECT id, name_ar, code FROM reps WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((r) => [r.id, r.code ? `${r.name_ar} (${r.code})` : r.name_ar]));
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private toRow(n: Location): NodeView {
    return {
      id: n.id,
      parentId: n.parentId ?? null,
      kind: n.kind,
      depth: n.depth,
      code: n.code ?? null,
      nameAr: n.nameAr,
      nameEn: n.nameEn ?? null,
      color: n.color ?? null,
      sortOrder: n.sortOrder,
      isActive: n.isActive,
      repId: n.repId ?? null,
    };
  }

  private allNodes(): Promise<Location[]> {
    return this.locations.find({ order: { depth: 'ASC', sortOrder: 'ASC', nameAr: 'ASC' } });
  }

  private async customerCountsByLocation(): Promise<Map<string, number>> {
    const rows: Array<{ location_id: string; n: string }> = await this.customers.query(
      `SELECT location_id, COUNT(*) AS n FROM customers
        WHERE deleted_at IS NULL AND location_id IS NOT NULL
        GROUP BY location_id`,
    );
    return new Map(rows.map((r) => [r.location_id, Number(r.n) || 0]));
  }

  private async customerIdsUnder(node: Location): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.customers.query(
      `SELECT c.id FROM customers c
         JOIN locations l ON l.id = c.location_id
        WHERE c.deleted_at IS NULL AND l.path LIKE $1`,
      [`${node.path}%`],
    );
    return rows.map((r) => r.id);
  }

  /** Re-root a node's subtree under `target`, in one statement. */
  private async movePath(node: Location, target: Location): Promise<void> {
    const newPath = `${target.path}${node.id}/`;
    const depthDelta = target.depth + 1 - node.depth;
    await this.locations.query(
      `UPDATE locations
          SET path = $1 || substr(path, length($2) + 1),
              depth = depth + $3
        WHERE path LIKE $4`,
      [newPath, node.path, depthDelta, `${node.path}%`],
    );
    node.parentId = target.id;
    node.path = newPath;
    node.depth += depthDelta;
  }

  private async nextSortOrder(parentId: string | null, m?: EntityManager): Promise<number> {
    const runner = m ?? this.dataSource.manager;
    const rows: Array<{ n: number | null }> = await runner.query(
      `SELECT MAX(sort_order) AS n FROM locations
        WHERE deleted_at IS NULL AND parent_id IS NOT DISTINCT FROM $1`,
      [parentId],
    );
    return rows[0]?.n == null ? 0 : Number(rows[0].n) + 1;
  }

  private normaliseCode(kind: LocationKind, code: string | undefined): string | null {
    const c = code?.trim();
    if (!c) return null;
    return kind === 'AREA' ? c : c.toUpperCase();
  }

  private async assertNameFree(parentId: string | null, nameAr: string, exceptId?: string): Promise<void> {
    const clash = await this.locations.findOne({
      where: { parentId: parentId ?? IsNull(), nameAr: nameAr.trim() },
    });
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(`"${nameAr.trim()}" already exists here. Use a different name.`);
    }
  }

  private async assertGovernorateCodeFree(code: string, exceptId?: string): Promise<void> {
    const clash = await this.locations.findOne({ where: { kind: 'GOVERNORATE', code } });
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(`The code ${code} already belongs to ${clash.nameAr}.`);
    }
  }

  private changed(reason: string): void {
    // No repId: every van re-pulls, as a flat area change does.
    this.events.emit('customer.changed', { reason });
  }

  /** In TREE mode a customer's place is its ERP address; re-send it. */
  private async placeChanged(customerIds: string[]): Promise<void> {
    if (!customerIds.length) return;
    if ((await this.settings.locationMode()) !== 'TREE') return;
    this.events.emit('erp.customer.area', { customerIds });
  }
}

/** Which customers a resolution looks at. */
export type RepScope = { all: true } | { nodePath: string } | { customerIds: string[] };

function scopeWhere(scope: RepScope): { where: string; params: unknown[] } {
  if ('nodePath' in scope) return { where: 'l.path LIKE $1', params: [`${scope.nodePath}%`] };
  if ('customerIds' in scope) return { where: 'c.id = ANY($1::uuid[])', params: [scope.customerIds] };
  return { where: 'TRUE', params: [] };
}

function emptyReport(dryRun: boolean): RepChangeReport {
  return { dryRun, applied: false, moved: 0, keptDirect: 0, byRep: [] };
}

/** The ids on a materialised path, root first: '/a/b/c/' → [a, b, c]. */
export function idsOnPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
