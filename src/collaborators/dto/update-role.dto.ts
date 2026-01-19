import { IsEnum } from 'class-validator';
export class UpdateRoleDto {
  @IsEnum(['OWNER','EDITOR','READER'] as const) role!: 'OWNER'|'EDITOR'|'READER';
}
