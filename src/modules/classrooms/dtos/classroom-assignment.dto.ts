import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Optional classroom block accepted by create-student and create-teacher so a
 * member can be assigned to a classroom in the same request. When present, every
 * level is required (Academic Year → Discipline → Batch → Section) — the hierarchy
 * is mandatory and levels cannot be skipped. The backend find-or-creates the
 * matching classroom (case-insensitive, trimmed) so no duplicates are produced.
 */
export class ClassroomAssignmentDto {
  @IsString()
  @IsNotEmpty({ message: 'Academic year is required' })
  @MaxLength(20)
  year!: string;

  @IsString()
  @IsNotEmpty({ message: 'Discipline is required' })
  @MaxLength(80)
  discipline!: string;

  @IsString()
  @IsNotEmpty({ message: 'Batch is required' })
  @MaxLength(120)
  batch!: string;

  @IsString()
  @IsNotEmpty({ message: 'Section is required' })
  @MaxLength(20)
  section!: string;
}
