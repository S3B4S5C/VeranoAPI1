import { IsArray, IsOptional, IsString, MinLength, ArrayMaxSize } from 'class-validator';

export class CreateProjectDto {
  @IsString() @MinLength(2)
  name!: string;

  @IsString() @IsOptional()
  description?: string;

  @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) @IsOptional()
  tags?: string[]; // nombres de tag (ej: ["backend","db"])
}
