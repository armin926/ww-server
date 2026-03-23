import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User } from './schemas/user.schema';
import { Model } from 'mongoose';
import type { RegisterDto } from './dto/register.dto';

@Injectable()
export class UserService {
  // 用户模型
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  // 注册用户
  async register(registerDto: RegisterDto) {
    const { username, email, password } = registerDto;

    // 检查用户名或邮箱是否已存在，Mongoose 查询语法 $or，$or 是一个数组，包含多个查询条件，满足其中之一即可。
    const existingUser = await this.userModel.findOne({
      $or: [{ username }, { email }],
    });
    if (existingUser) {
      throw new Error('用户名或邮箱已存在');
    }

    // 创建新用户
    const newUser = new this.userModel({
      username,
      email,
      password,
    });
    // 保存新用户到数据库
    await newUser.save();

    const result = newUser.toObject();
    // 删除密码字段，不返回给客户端
    delete result.password;
    return result;
  }
}
