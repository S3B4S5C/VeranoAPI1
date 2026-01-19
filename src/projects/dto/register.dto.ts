import { IsEmail, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72) // límite razonable para bcrypt
  password!: string;

  @IsString()
  @IsOptional()
  name?: string;
}
