import { IsOptional, IsString } from 'class-validator';

export class SaveModelDto {
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() message?: string;
  // el contenido llega como JSON en el body; Nest lo parsea, no tipamos aquí
}
