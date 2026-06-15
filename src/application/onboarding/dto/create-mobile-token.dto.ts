import { Type } from 'class-transformer'
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator'

export class MobileDocumentTargetDto {
  @IsString()
  @MaxLength(120)
  key: string

  @IsString()
  @MaxLength(120)
  document_type: string

  @IsIn(['person', 'business', 'director', 'ubo'])
  subject_type: 'person' | 'business' | 'director' | 'ubo'

  @IsString()
  @MaxLength(180)
  label: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  observation?: string
}

export class CreateMobileTokenDto {
  @IsIn(['personal', 'company'])
  onboarding_type: 'personal' | 'company'

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => MobileDocumentTargetDto)
  documents: MobileDocumentTargetDto[]
}
