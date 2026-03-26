import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionManager } from '../../ai/services/session.manager';
import { ResumeAnalysisService } from './resume-analysis.service';
import { ConversationContinuationService } from './conversation-continuation.service';
import { RESUME_ANALYSIS_SYSTEM_MESSAGE } from '../prompt/resume-quiz.prompt';

@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  constructor(
    private configService: ConfigService,
    private sessionManager: SessionManager,
    private resumeAnalysisService: ResumeAnalysisService,
    private conversationContinuationService: ConversationContinuationService,
  ) {}

  /**
   * 分析简历（首轮，建立会话）
   * @param userId 用户ID
   * @param posistion 岗位
   * @param resumeContent 简历内容
   * @param jobDescription 岗位描述
   */
  async analyzeResume(
    userId: string,
    posistion: string,
    resumeContent: string,
    jobDescription: string,
  ) {
    try {
      // 第一步：创建新会话
      const systemMessage = RESUME_ANALYSIS_SYSTEM_MESSAGE(posistion);
      const sessionId = this.sessionManager.createSession(
        userId,
        posistion,
        systemMessage,
      );
      this.logger.log(`创建会话：${sessionId}`);
      // 第二步：调用专门的简历分析服务
      const result = await this.resumeAnalysisService.analyze(
        resumeContent,
        jobDescription,
      );
      // 第三步：保存用户输入到历史会话
      this.sessionManager.addMessage(
        sessionId,
        'user',
        `简历内容：${resumeContent}`,
      );
      // 第四步：保存AI的回复到历史会话
      this.sessionManager.addMessage(
        sessionId,
        'assistant',
        JSON.stringify(result),
      );
      this.logger.log(`简历分析完成，sessionId: ${sessionId}`);

      return {
        sessionId,
        analysis: result,
      };
    } catch (error) {
      this.logger.error('简历分析失败', error);
      throw error;
    }
  }

  /**
   * 继续对话（多轮，基于现有会话）
   *
   * @param sessionId 会话ID
   * @param userQuestion 用户问题
   * @returns AI的回复
   */
  async continueConversation(
    sessionId: string,
    userQuestion: string,
  ): Promise<string> {
    try {
      // 第一步：添加用户问题到历史会话
      this.sessionManager.addMessage(sessionId, 'user', userQuestion);
      // 第二步：获取历史对话
      const history = this.sessionManager.getRecentMessages(sessionId, 10);

      this.logger.log(
        `继续对话，sessionId: ${sessionId}，历史消息数：${history.length}`,
      );

      // 第三步：调用专门的对话继续服务
      const aiResponse =
        await this.conversationContinuationService.continue(history);
      // 第四步：保存AI的回答到历史会话
      this.sessionManager.addMessage(sessionId, 'assistant', aiResponse);
      this.logger.log(`继续对话完成，sessionId: ${sessionId}`);
      return aiResponse;
    } catch (error) {
      this.logger.error('继续对话失败', error);
      throw error;
    }
  }
}
