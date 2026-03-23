import { Controller, Post, Body } from '@nestjs/common';
import { UserService } from './user.service';
import type { RegisterDto } from './dto/register.dto';
import { ResponseUtil } from 'src/common/utils/response.util';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    const result = await this.userService.register(registerDto);
    return ResponseUtil.success(result, '注册成功');
  }
}
