import { IsBoolean, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';

export class UpsertAnswerDto {
  @IsOptional()
  @IsObject()
  answerPayload?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60 * 60 * 8)
  timeSpentSeconds?: number;

  @IsOptional()
  @IsBoolean()
  isFlagged?: boolean;
}

export class HeartbeatDto {
  @IsInt()
  @Min(0)
  @Max(60 * 60 * 8)
  clientTimeRemainingSeconds!: number;
}
