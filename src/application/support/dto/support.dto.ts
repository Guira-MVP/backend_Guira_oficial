import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTicketDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional()
  @IsEmail()
  @IsOptional()
  contact_email?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contact_phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  reference_type?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  reference_id?: string;
}

export class AssignTicketDto {
  @ApiProperty({ description: 'ID del agente/staff' })
  @IsUUID()
  @IsNotEmpty()
  staff_user_id: string;
}

export class ResolveTicketDto {
  @ApiProperty({ description: 'Notas de la resolución' })
  @IsString()
  @IsNotEmpty()
  resolution_notes: string;
}

export class UpdateTicketStatusDto {
  @ApiProperty({ example: 'in_progress' })
  @IsString()
  @IsNotEmpty()
  status: string;
}
