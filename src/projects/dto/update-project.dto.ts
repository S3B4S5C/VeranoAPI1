import { IsArray, IsOptional, IsString, MinLength, ArrayMaxSize } from 'class-validator';

export class UpdateProjectDto {
  @IsString() @MinLength(2) @IsOptional()
  name?: string;

  @IsString() @IsOptional()
  description?: string;

  @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) @IsOptional()
  tags?: string[];
}
