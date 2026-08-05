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

  // 'ubo' se retiró: a diferencia de 'director' y 'person' (ambos únicos por
  // usuario en este flujo), un negocio puede tener varios UBOs y no hay
  // forma de resolver a cuál pertenece un documento subido sin subject_id —
  // este DTO no lo tiene. Agregarlo de nuevo requiere primero sumar
  // subject_id aquí y una lógica de reclamo como la de upsertLegalRepresentative.
  @IsIn(['person', 'business', 'director'])
  subject_type: 'person' | 'business' | 'director'

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
