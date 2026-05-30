import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth/decorators/public.decorator';

@Controller()
export class AppController {
  @Public()
  @Get()
  healthCheck() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
