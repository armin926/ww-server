import { Injectable, Logger } from '@nestjs/common';
import { SessionData, Message } from '../interface/message.interface';
import { v4 as generateUUID } from 'uuid';

/**
 * 会话管理服务
 *
 * 这个服务负责管理用户和 AI 的对话会话。
 * - 维护对话历史（内存存储）
 * - 管理会话的生命周期
 * - 提供会话数据的查询方法
 *
 * 为什么要在AI模块里？
 * 因为对话历史管理是 AI 交互的核心功能。
 * 任何射击 AI 多轮对话的服务（简历分析、出题、评估等）都需要用到它。
 * 所以我们把它放在 AI 模块，作为通用服务供所有模块使用
 */
@Injectable()
export class SessionManager {
  private readonly logger = new Logger(SessionManager.name);

  // 内存存储：sessionId -> 对话历史
  private sessions = new Map<string, SessionData>();

  /**
   *
   * 创建一个新的会话
   *
   * @param userId 用户ID
   * @param position 职位名称（用于System Message）
   * @param systemMessage 系统消息(ai的角色定义)
   * @returns 会话ID
   */
  createSession(
    userId: string,
    position: string,
    systemMessage: string,
  ): string {
    const sessionId = generateUUID();

    const sessionData: SessionData = {
      userId,
      position,
      sessionId,
      messages: [{ role: 'system', content: systemMessage }],
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    this.sessions.set(sessionId, sessionData);
    this.logger.log(
      `创建会话： ${sessionId}，用户：${userId}，职位：${position}`,
    );
    return sessionId;
  }

  /**
   * 向会话添加消息
   * @param sessionId 会话ID
   * @param role 消息角色（User 或 assistant）
   * @param content 消息内容
   */
  addMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.messages.push({
      role,
      content,
    });
    session.lastActivityAt = new Date();
    this.logger.debug(`添加消息到会话 ${sessionId}：${role}`);
  }

  /**
   * 获取会话历史
   * @param sessionId 会话ID
   * @returns 会话历史
   */
  getHistory(sessionId: string): Message[] {
    const session = this.sessions.get(sessionId);
    return session?.messages || [];
  }

  /**
   * 获取最近的 N 条消息（用于优化Token 使用）
   *
   * 为什么要这样做？
   * 对话越长，token越多，调用ai的成本越高
   * 所以我们只保留最近的几条消息，旧的消息可以丢掉。
   * 但注意：System Message 第一条，一定要保留！
   *
   * @param sessionId 会话ID
   * @param count 最近的消息数量（不包括System Message第一条）
   * @returns 包含System message + 最近的 N 条消息的数组
   */
  getRecentMessages(sessionId: string, count: number = 10): Message[] {
    const history = this.getHistory(sessionId);
    if (history.length === 0) return [];

    // 获取System Message第一条，一定要保留，在该项目中，第一条消息通常是自我介绍
    const systemMessage = history[0];

    // 获取最近的 N 条消息
    const recentMessage = history.slice(-count);

    // 如果最近的消息中不包含System Message，则添加System Message
    if (recentMessage[0]?.role !== 'system') {
      return [systemMessage, ...recentMessage];
    }

    return recentMessage;
  }

  /**
   * 结束会话
   * @param sessionId
   */
  endSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      this.logger.log(`结束会话： ${sessionId}`);
    }
  }

  cleanupExpiredSessions(): void {
    const now = new Date();
    const expirationTime = 1000 * 60 * 60; // 1 小时
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now.getTime() - session.lastActivityAt.getTime() > expirationTime) {
        this.logger.warn(`会话 ${sessionId} 已过期，清理会话`);
        this.sessions.delete(sessionId);
      }
    }
  }
}
