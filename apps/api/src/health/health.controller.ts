import { Controller, Get } from '@nestjs/common';
import { Public } from '../context/context.guard.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
