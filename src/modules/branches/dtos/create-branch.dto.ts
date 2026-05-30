import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}
