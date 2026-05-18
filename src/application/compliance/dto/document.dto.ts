import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SubjectType {
  ONBOARDING = 'onboarding',
  PAYOUT_REQUEST = 'payout_request',
  SUPPLIER = 'supplier',
}

export enum DocumentType {
  PASSPORT = 'passport',
  ID_CARD = 'id_card',
  ARTICLES_OF_INCORPORATION = 'articles_of_incorporation',
  ADDRESS_PROOF = 'address_proof',
  INVOICE = 'invoice',
  OTHER = 'other',
}

export class RegisterDocumentDto {
  @ApiProperty({ enum: SubjectType })
  @IsEnum(SubjectType)
  subject_type: SubjectType;

  @ApiProperty({ example: 'uuid-of-the-subject' })
  @IsUUID()
  subject_id: string;

  @ApiProperty({ enum: DocumentType })
  @IsEnum(DocumentType)
  document_type: DocumentType;

  @ApiProperty({ example: 'kyc-documents/user-id/passport.pdf' })
  @IsString()
  @IsNotEmpty()
  storage_path: string;

  @ApiProperty({ example: 'passport.pdf' })
  @IsString()
  @IsNotEmpty()
  file_name: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  mime_type: string;

  @ApiPropertyOptional({ example: 845231 })
  @IsOptional()
  file_size_bytes?: number;

  @ApiPropertyOptional({ example: 'Pasaporte vigente de William Velazquez' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class GetDocumentUploadUrlDto {
  @ApiProperty({ example: 'kyc-documents' })
  @IsEnum(['kyc-documents', 'supplier-documents'])
  bucket: 'kyc-documents' | 'supplier-documents';

  @ApiProperty({ example: 'passport.pdf' })
  @IsString()
  @IsNotEmpty()
  file_name: string;
}
