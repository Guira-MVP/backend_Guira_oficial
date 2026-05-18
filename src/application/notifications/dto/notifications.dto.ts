import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum NotificationType {
  FINANCIAL = 'financial',
  ONBOARDING = 'onboarding',
  COMPLIANCE = 'compliance',
  SYSTEM = 'system',
  SUPPORT = 'support',
  ALERT = 'alert',
}

export class CreateNotificationDto {
  @ApiProperty({ description: 'ID del usuario destino' })
  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  @IsNotEmpty()
  type: NotificationType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  link?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  referenceType?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  referenceId?: string;
}
