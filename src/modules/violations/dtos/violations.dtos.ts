import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';

const TYPES = [
  'TAB_SWITCH',
  'FULLSCREEN_EXIT',
  'COPY_ATTEMPT',
  'PASTE_ATTEMPT',
  'RIGHT_CLICK',
  'WINDOW_BLUR',
  'DEVTOOLS_OPEN',
  'NETWORK_DROP',
] as const;
type ViolationTypeLiteral = (typeof TYPES)[number];

export class ViolationEventDto {
  @IsEnum(TYPES)
  type!: ViolationTypeLiteral;

  @IsDateString()
  clientTimestamp!: string;

  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;
}

export class RecordViolationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60) // matches throttler limit of 60/10s
  @ValidateNested({ each: true })
  @Type(() => ViolationEventDto)
  events!: ViolationEventDto[];
}
