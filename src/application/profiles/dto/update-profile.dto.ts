import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'avatars/user-id/avatar.jpg' })
  @IsOptional()
  @IsString()
  avatar_url?: string;
}
