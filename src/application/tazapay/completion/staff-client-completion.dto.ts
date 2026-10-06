import { PartialType } from '@nestjs/swagger';
import { CreatePersonDto } from '../../onboarding/dto/create-person.dto';
import { CreateBusinessDto } from '../../onboarding/dto/create-business.dto';
import {
  CreateDirectorDto,
  CreateUboDto,
} from '../../onboarding/dto/create-director-ubo.dto';

/**
 * Edición parcial: el staff completa lo que falta sin reescribir el
 * expediente entero. Al CREAR una fila nueva se exige el DTO completo (ver
 * StaffClientCompletionService.assertFull).
 */
export class StaffUpdatePersonDto extends PartialType(CreatePersonDto) {}
export class StaffUpdateBusinessDto extends PartialType(CreateBusinessDto) {}
export class StaffUpdateDirectorDto extends PartialType(CreateDirectorDto) {}
export class StaffUpdateUboDto extends PartialType(CreateUboDto) {}
