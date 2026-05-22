import { IsIn, IsArray, IsString, ArrayNotEmpty } from 'class-validator'

export class CreateMobileTokenDto {
  @IsIn(['personal', 'company'])
  onboarding_type: 'personal' | 'company'

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  required_docs: string[]
}
