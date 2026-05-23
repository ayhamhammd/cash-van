import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({
    summary: 'Create user',
    description: 'Create a new user account with login code, password and permission flags.',
  })
  @ApiCreatedResponse({ description: 'User created' })
  async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    const user = await this.usersService.create(dto);
    return UserResponseDto.fromEntity(user);
  }

  @Get()
  @ApiOperation({
    summary: 'List users',
    description: 'Paginated list of users.',
  })
  @ApiOkResponse({ description: 'Paginated user list' })
  async list(@Query() query: PaginationDto) {
    const result = await this.usersService.paginate(query);
    return { ...result, items: result.items.map(UserResponseDto.fromEntity) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user', description: 'Fetch a single user by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiOkResponse({ description: 'The user' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findOneOrThrow(id);
    return UserResponseDto.fromEntity(user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update user',
    description: 'Update user fields and/or permission flags.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiOkResponse({ description: 'Updated user' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.update(id, dto);
    return UserResponseDto.fromEntity(user);
  }

  @Patch(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Change password',
    description: 'Reset or change a user password.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiNoContentResponse({ description: 'Password changed' })
  async changePassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.usersService.changePassword(id, dto.newPassword);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete user', description: 'Soft-delete a user.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiNoContentResponse({ description: 'User soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.usersService.remove(id);
  }
}
