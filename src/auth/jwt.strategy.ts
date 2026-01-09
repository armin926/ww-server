// 导入所需的模块和服务
import { Injectable, Logger } from '@nestjs/common'; // 引入NestJS的依赖注入装饰器
import { PassportStrategy } from '@nestjs/passport'; // 引入PassportStrategy基类，用于扩展策略
import { Strategy, ExtractJwt } from 'passport-jwt'; // 引入JWT策略和提取JWT的方法
import { ConfigService } from '@nestjs/config'; // 引入NestJS的配置服务，用于获取配置项

// 使用@Injectable装饰器使JwtStrategy可以被NestJS的依赖注入系统管理
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  // 构造函数接收ConfigService实例，用于获取配置
  constructor(private readonly configService: ConfigService) {
    // 获取 JWT Secret（用于签名验证）
    const jwtSecret =
      configService.get<string>('JWT_SECRET') || 'wwzhidao-secret';

    // 调用父类构造函数，传递JWT的配置选项
    super({
      // 从请求的Authorization头部提取Bearer Token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      // 不忽略JWT的过期时间（默认为false）
      ignoreExpiration: false,

      // 获取JWT的密钥，如果配置中没有找到，则使用默认值'wwzhidao-secret'
      // ⚠️ 注意：这里的 secret 必须与 app.module.ts 中 JwtModule 的 secret 保持一致
      secretOrKey: jwtSecret,
    });

    // 记录 JWT Secret 配置（仅记录是否使用默认值，不记录实际密钥）
    if (!configService.get<string>('JWT_SECRET')) {
      this.logger.warn(
        '⚠️ JWT_SECRET 未配置，使用默认值。生产环境请务必设置环境变量 JWT_SECRET',
      );
    } else {
      this.logger.log('✅ JWT_SECRET 已从环境变量加载');
    }
  }

  // validate方法是JWT验证通过后执行的逻辑
  // payload是解密后的JWT数据
  async validate(payload: any) {
    // 返回有效的用户信息（可以将其存储在请求的user对象中，后续中间件可以访问）
    return {
      userId: payload.userId, // 用户ID
      username: payload.username, // 用户名
      email: payload.email, // 用户邮箱
    };
  }
}
