import { Module } from '@nestjs/common';
import { AIModelFactory } from './ai-model.factory';
import { SessionManager } from './session.manager';

/**
 * AI 模块
 *
 * 这个模块集中管理所有的 AI 相关服务。
 * - AIModelFactory：AI 模型工厂，用于创建不同的 AI 模型（初始化）。
 * - SessionManager：会话管理器，用于管理用户会话（管理对话历史）。
 *
 * 任何需要使用 AI 服务的模块都必须导入这个模块。
 */
@Module({
  // 提供者，这样模块内部可以使用
  providers: [AIModelFactory, SessionManager],
  // 导出，这样其他模块可以使用
  exports: [AIModelFactory, SessionManager],
})
export class AIModule {}
