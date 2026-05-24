import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTOs for the mobile BFF. Field names follow the frontend contract
 * (`12-frontend_API`) exactly; these objects appear inside the standard
 * `{ success, data, timestamp }` envelope.
 */

export class SalesmanDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: 'أحمد المصري' }) salesmanNameAr!: string;
  @ApiProperty({ example: 'Ahmad Al-Masri', nullable: true }) salesmanNameEn!: string | null;
  @ApiProperty({ example: '0791234567', nullable: true }) salesmanPhone!: string | null;
  @ApiProperty({ example: 'R-A01', nullable: true }) routeCode!: string | null;
  @ApiProperty({ example: 'مسار وسط عمان', nullable: true }) routeNameAr!: string | null;
  @ApiProperty({ example: 'Central Amman Route', nullable: true }) routeNameEn!: string | null;
  @ApiProperty({ example: '4', nullable: true }) storeNumber!: string | null;
  @ApiProperty({ example: '1', description: 'Default price phase (single-price build → always "1")' })
  pricePhase!: string;
  @ApiProperty({ example: true }) isActive!: boolean;
}

export class CompanyMetaDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: 'كاش فلو للتجارة' }) companyName!: string;
  @ApiProperty({ example: '23423423', nullable: true }) taxNumber!: string | null;
  @ApiProperty({ example: '0793232334', nullable: true }) companyPhone!: string | null;
  @ApiProperty({ example: 'https://cdn.example.com/logo.png', description: 'Logo URL or "" ' })
  logo!: string;
}

export class ItemUnitDto {
  @ApiProperty({ example: 'كرتونة' }) unitName!: string;
  @ApiProperty({ example: '4423524', description: 'Unit barcode' }) unitCode!: string;
  @ApiProperty({ example: '4.200', description: '3-decimal JOD price' }) unitPrice!: string;
  @ApiProperty({ example: '25', description: 'Available stock for this unit in the van' })
  unitQty!: string;
}

export class ItemPriceDto {
  @ApiProperty({ example: '1' }) phaseNumber!: string;
  @ApiProperty({ example: '0.350' }) phasePrice!: string;
}

export class ItemDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: '23232' }) itemCode!: string;
  @ApiProperty({ example: 'مياه معدنية بركة 1.5 لتر' }) itemNameAr!: string;
  @ApiProperty({ example: 'Baraka Mineral Water 1.5L', nullable: true }) itemNameEn!: string | null;
  @ApiProperty({ example: '0.350' }) itemPrice!: string;
  @ApiProperty({ example: '4533455' }) itemBarcode!: string;
  @ApiProperty({ example: 'https://cdn.example.com/items/23232.jpg', description: 'URL or "" ' })
  itemPic!: string;
  @ApiProperty({ example: 'Drinks', nullable: true }) itemCategory!: string | null;
  @ApiProperty({ example: '16' }) taxPerc!: string;
  @ApiProperty({ type: [ItemUnitDto] }) itemUnits!: ItemUnitDto[];
  @ApiProperty({ type: [ItemPriceDto] }) itemPriceList!: ItemPriceDto[];
}

export class ItemBalanceRowDto {
  @ApiProperty({ example: 'C001' }) companyNumber!: string;
  @ApiProperty({ example: 'S012' }) salesmanCode!: string;
  @ApiProperty({ example: '231312' }) itemNumber!: string;
  @ApiProperty({ example: '40' }) itemQty!: string;
  @ApiProperty({ example: '1' }) storeNumber!: string;
}
