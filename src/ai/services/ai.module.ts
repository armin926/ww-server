import { Module } from '@nestjs/common';
import { AIModelFactory } from './ai-model.factory';

/**
 * AI 模块
 *
 * 这个模块集中管理所有的 AI 相关服务。
 * 目前只有 AIModelFactory 一个服务。
 */
@Module({
  // 提供者，这样模块内部可以使用
  providers: [AIModelFactory],
  // 导出，这样其他模块可以使用
  exports: [AIModelFactory],
})
export class AIModule {}
