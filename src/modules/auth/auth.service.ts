import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { UsersService } from '../users/users.service';
import { RepsService } from '../reps/reps.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { User } from '../users/entities/user.entity';

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    userNumber: string;
    name: string;
    userType: string;
    role: string;
    /** Field-rep id linked to this user, or null if not a rep. */
    repId: string | null;
    permissions: Record<string, boolean>;
    /** Granular dashboard permission keys. */
    permKeys: string[];
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly repsService: RepsService,
    private readonly jwtService: JwtService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.usersService.findByUserNumberWithSecret(dto.userNumber);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('User is disabled');
    }

    // Stamp last_login_at (best-effort; ignore failure).
    await this.userRepo
      .update(user.id, { lastLoginAt: new Date() })
      .catch(() => undefined);

    // Map the logged-in user to their field rep (1:1), if any.
    const rep = await this.repsService.findByUserId(user.id);
    const repId = rep?.id ?? null;

    const permissions = this.extractPermissions(user);
    const permKeys = user.permissions ?? [];
    const payload: JwtPayload = {
      sub: user.id,
      v: 2,
      userNumber: user.userNumber,
      userType: user.userType,
      role: user.role ?? 'viewer',
      repId,
      permissions,
      permKeys,
    };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        userNumber: user.userNumber,
        name: user.name,
        userType: user.userType,
        role: user.role ?? 'viewer',
        repId,
        permissions,
        permKeys,
      },
    };
  }

  private extractPermissions(user: User): Record<string, boolean> {
    return {
      canMakeVoucher: user.canMakeVoucher,
      canEditVoucher: user.canEditVoucher,
      canAddCustomer: user.canAddCustomer,
      canEditCustomerCredit: user.canEditCustomerCredit,
      canAddItems: user.canAddItems,
      canEditExpiry: user.canEditExpiry,
    };
  }
}
