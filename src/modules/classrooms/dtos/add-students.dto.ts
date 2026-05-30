import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class AddStudentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  studentIds!: string[];
}
