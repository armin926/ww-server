import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, LogLevel } from '@nestjs/common';

async function bootstrap() {
  const logLevels: LogLevel[] = ['log', 'error', 'warn', 'debug', 'verbose'];
  const app = await NestFactory.create(AppModule, {
    logger: logLevels,
  });

  // 全局验证管道
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 自动移除 DTO 中没有声明的字段
      transform: true, // 自动类型转换
    }),
  );

  // 启用 CORS
  app.enableCors();

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
