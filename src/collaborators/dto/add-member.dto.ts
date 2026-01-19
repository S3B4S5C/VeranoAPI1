import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';

export class AddMemberDto {
  @IsEnum(['OWNER','EDITOR','READER'] as const) role!: 'OWNER'|'EDITOR'|'READER';

  // identifica al usuario por id o email
  @IsString() @IsOptional() userId?: string;
  @IsEmail()  @IsOptional() email?: string;
}
