// src/interview/services/interview.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionManager } from '../../ai/services/session.manager';
import { ResumeAnalysisService } from './resume-analysis.service';
import { ConversationContinuationService } from './conversation-continuation.service';
import { RESUME_ANALYSIS_SYSTEM_MESSAGE } from '../prompts/resume-analysis.prompts';
import { Subject } from 'rxjs';
import { ResumeQuizDto } from '../dto/resume-quiz.dto';
import { v4 as uuidv4 } from 'uuid';
import { ConsumptionStatus } from '../schemas/consumption-record.schema';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User, UserDocument } from '../../user/schemas/user.schema';
import { Model, Types } from 'mongoose';
import {
  ConsumptionRecord,
  ConsumptionRecordDocument,
} from '../schemas/consumption-record.schema';
import {
  ResumeQuizResult,
  ResumeQuizResultDocument,
} from '../schemas/interview-quiz-result.schema';
import { DocumentParserService } from './document-parser.service';
import { InterviewAIService } from './interview-ai.service';
import { AIInterviewType } from '../schemas/ai-interview-result.schema';
import {
  StartMockInterviewDto,
  MockInterviewEventDto,
  MockInterviewEventType,
  MockInterviewType,
} from '../dto/mock-interview.dto';
import {
  AIInterviewResult,
  AIInterviewResultDocument,
} from '../schemas/ai-interview-result.schema';

/**
 * 进度事件
 */
export interface ProgressEvent {
  type: 'progress' | 'complete' | 'error' | 'timeout';
  step?: number;
  label?: string;
  progress: number; // 0-100
  message?: string;
  data?: any;
  error?: string;
  stage?: 'prepare' | 'generating' | 'saving' | 'done'; // 当前阶段
}

/**
 * 消费类型枚举
 */
export enum ConsumptionType {
  RESUME_QUIZ = 'resume_quiz', // 简历押题
  SPECIAL_INTERVIEW = 'special_interview', // 专项面试
  BEHAVIOR_INTERVIEW = 'behavior_interview', // 行测+HR面试
  AI_INTERVIEW = 'ai_interview', // AI模拟面试（如果使用次数计费）
}

/**
 * 面试会话（内存中）
 */
interface InterviewSession {
  sessionId: string; // 临时ID，用于这次面试
  resultId?: string; // 数据库中的持久化ID
  consumptionRecordId?: string; // 消费记录ID

  // 用户信息
  userId: string; // 用户ID
  interviewType: MockInterviewType; // 面试类型（专项/综合）
  interviewerName: string; // 面试官名字
  candidateName?: string; // 候选人名字

  // 岗位信息
  company: string; // 公司名称
  positionName?: string; // 岗位名称
  salaryRange?: string; // 薪资范围
  jd?: string; // 职位描述
  resumeContent: string; // 简历内容（保存，用于后续问题生成）

  // 对话历史
  conversationHistory: Array<{
    role: 'interviewer' | 'candidate';
    content: string;
    timestamp: Date;
    standardAnswer?: string; // 标准答案（仅面试官问题有）
  }>;

  // 进度追踪
  questionCount: number; // 已问的问题数
  startTime: Date; // 开始时间
  targetDuration: number; // 预期时长（分钟）

  // 状态
  isActive: boolean; // 是否活跃（用于判断是否已结束）
}

/**
 * 面试服务
 *
 * 这个服务只关心业务逻辑和流程编排：
 * 1. 创建会话
 * 2. 调用具体的分析服务（简历分析、对话继续等）
 * 3. 管理会话历史
 *
 * 不关心具体的 AI 实现细节，那些交给专门的分析服务。
 */
@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);
  // 面试时长限制（分钟）
  private readonly SPECIAL_INTERVIEW_MAX_DURATION = 120; // 专项面试最大时长（分钟）
  private readonly BEHAVIOR_INTERVIEW_MAX_DURATION = 120; // 行测+HR面试最大时长（分钟）

  // 存储活跃的面试会话（内存中）
  private interviewSessions: Map<string, InterviewSession> = new Map();

  constructor(
    private configService: ConfigService,
    private sessionManager: SessionManager,
    private resumeAnalysisService: ResumeAnalysisService,
    private conversationContinuationService: ConversationContinuationService,
    private documentParserService: DocumentParserService,
    private aiService: InterviewAIService,
    @InjectModel(ConsumptionRecord.name)
    private consumptionRecordModel: Model<ConsumptionRecordDocument>,
    @InjectModel(ResumeQuizResult.name)
    private resumeQuizResultModel: Model<ResumeQuizResultDocument>,
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    @InjectModel(AIInterviewResult.name)
    private aiInterviewResultModel: Model<AIInterviewResultDocument>,
  ) {}

  /**
   * 分析简历（首轮，创建会话）
   *
   * @param userId 用户 ID
   * @param position 职位名称
   * @param resumeContent 简历内容
   * @param jobDescription 岗位要求
   * @returns 分析结果和 sessionId
   */
  async analyzeResume(
    userId: string,
    position: string,
    resumeContent: string,
    jobDescription: string,
  ) {
    try {
      // 第一步：创建新会话
      const systemMessage = RESUME_ANALYSIS_SYSTEM_MESSAGE(position);
      const sessionId = this.sessionManager.createSession(
        userId,
        position,
        systemMessage,
      );

      this.logger.log(`创建会话: ${sessionId}`);

      // 第二步：调用专门的简历分析服务
      const result = await this.resumeAnalysisService.analyze(
        resumeContent,
        jobDescription,
      );

      // 第三步：保存用户输入到会话历史
      this.sessionManager.addMessage(
        sessionId,
        'user',
        `简历内容：${resumeContent}`,
      );

      // 第四步：保存 AI 的回答到会话历史
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
      this.logger.error(`分析简历失败: ${error}`);
      throw error;
    }
  }

  /**
   * 继续对话（多轮，基于现有会话）
   *
   * @param sessionId 会话 ID
   * @param userQuestion 用户问题
   * @returns AI 的回答
   */
  async continueConversation(
    sessionId: string,
    userQuestion: string,
  ): Promise<string> {
    try {
      // 第一步：添加用户问题到会话历史
      this.sessionManager.addMessage(sessionId, 'user', userQuestion);

      // 第二步：获取对话历史
      const history = this.sessionManager.getRecentMessages(sessionId, 10);

      this.logger.log(
        `继续对话，sessionId: ${sessionId}，历史消息数: ${history.length}`,
      );

      // 第三步：调用专门的对话继续服务
      const aiResponse =
        await this.conversationContinuationService.continue(history);

      // 第四步：保存 AI 的回答到会话历史
      this.sessionManager.addMessage(sessionId, 'assistant', aiResponse);

      this.logger.log(`对话继续完成，sessionId: ${sessionId}`);

      return aiResponse;
    } catch (error) {
      this.logger.error(`继续对话失败: ${error}`);
      throw error;
    }
  }

  /**
   * 生成简历押题（带流式进度）
   * @param userId 用户ID
   * @param dto 请求参数
   * @returns Subject 流式事件
   */
  generateResumeQuizWithProgress(
    userId: string,
    dto: ResumeQuizDto,
  ): Subject<ProgressEvent> {
    const subject = new Subject<ProgressEvent>();

    // 异步执行，通过 Subject 发送进度
    this.executeResumeQuiz(userId, dto, subject).catch((error) => {
      subject.error(error);
    });

    return subject;
  }

  /**
   * 执行简历押题（核心业务逻辑）
   */
  private async executeResumeQuiz(
    userId: string,
    dto: ResumeQuizDto,
    progressSubject?: Subject<ProgressEvent>,
  ): Promise<any> {
    let consumptionRecord: any = null;
    const recordId = uuidv4();
    const resultId = uuidv4();
    console.log('recordId', recordId);

    // 处理错误
    try {
      // ========== 步骤 0: 幂等性检查 ==========
      // ⚠️ 这是最关键的一步：防止重复生成
      if (dto.requestId) {
        // 在数据库中查询是否存在这个 requestId 的记录
        const existingRecord = await this.consumptionRecordModel.findOne({
          userId,
          'metadata.requestId': dto.requestId,
          status: {
            $in: [ConsumptionStatus.SUCCESS, ConsumptionStatus.PENDING],
          },
        });

        if (existingRecord) {
          // 找到了相同 requestId 的记录！

          if (existingRecord.status === ConsumptionStatus.SUCCESS) {
            // 之前已经成功生成过，直接返回已有的结果
            this.logger.log(
              `重复请求，返回已有结果: requestId=${dto.requestId}`,
            );

            // 查询之前生成的结果
            const existingResult = await this.resumeQuizResultModel.findOne({
              resultId: existingRecord.resultId,
            });

            if (!existingResult) {
              throw new BadRequestException('结果不存在');
            }

            // ✅ 直接返回，不再执行后续步骤，不再扣费
            return {
              resultId: existingResult.resultId,
              questions: existingResult.questions,
              summary: existingResult.summary,
              remainingCount: await this.getRemainingCount(userId, 'resume'),
              consumptionRecordId: existingRecord.recordId,
              // ⭐ 重要：标记这是从缓存返回的结果
              isFromCache: true,
            };
          }

          if (existingRecord.status === ConsumptionStatus.PENDING) {
            // 同一个请求还在处理中，告诉用户稍后查询
            throw new BadRequestException('请求正在处理中，请稍后查询结果');
          }
        }
      }

      // ========== 步骤 1: 检查并扣除次数（原子操作）==========
      // ⚠️ 注意：扣费后如果后续步骤失败，会在 catch 块中自动退款

      const user = await this.userModel.findOneAndUpdate(
        {
          _id: userId,
          resumeRemainingCount: { $gt: 0 }, // 条件：必须余额 > 0
        },
        {
          $inc: { resumeRemainingCount: -1 }, // 原子操作：余额 - 1
        },
        { new: false }, // 返回更新前的文档，用于日志记录
      );

      // 检查扣费是否成功
      if (!user) {
        throw new BadRequestException('简历押题次数不足，请前往充值页面购买');
      }

      // 记录详细日志
      this.logger.log(
        `✅ 用户扣费成功: userId=${userId}, 扣费前=${user.resumeRemainingCount}, 扣费后=${user.resumeRemainingCount - 1}`,
      );

      // ========== 步骤 2: 创建消费记录（pending）==========

      consumptionRecord = await this.consumptionRecordModel.create({
        recordId, // 消费记录唯一ID
        user: new Types.ObjectId(userId),
        userId,
        type: ConsumptionType.RESUME_QUIZ, // 消费类型
        status: ConsumptionStatus.PENDING, // ⭐ 关键：标记为处理中
        consumedCount: 1, // 消费次数
        description: `简历押题 - ${dto?.company} ${dto.positionName}`,

        // 记录输入参数（用于调试和重现问题）
        inputData: {
          company: dto?.company || '',
          positionName: dto.positionName,
          minSalary: dto.minSalary,
          maxSalary: dto.maxSalary,
          jd: dto.jd,
          resumeId: dto.resumeId,
        },

        resultId, // 结果ID（稍后会生成）

        // 元数据（包含幂等性检查的 requestId）
        metadata: {
          requestId: dto.requestId, // ← 用于幂等性检查
          promptVersion: dto.promptVersion,
        },

        startedAt: new Date(), // 记录开始时间
      });

      this.logger.log(`✅ 消费记录创建成功: recordId=${recordId}`);

      // ========== 阶段 1: 准备阶段==========
      this.emitProgress(
        progressSubject,
        0,
        '📄 正在读取简历文档...',
        'prepare',
      );
      this.logger.log(`📝 开始提取简历内容: resumeId=${dto.resumeId}`);
      const resumeContent = await this.extractResumeContent(userId, dto);
      this.logger.log(`✅ 简历内容提取成功: ${resumeContent}`);
      this.logger.log(`✅ 简历内容提取成功: 长度=${resumeContent.length}字符`);

      this.emitProgress(progressSubject, 5, '✅ 简历解析完成', 'prepare');

      this.emitProgress(
        progressSubject,
        10,
        '🚀 准备就绪，即将开始 AI 生成...',
      );
      // ========== 阶段 2: AI 生成阶段 - 分两步（10-90%）==========
      const aiStartTime = Date.now();

      this.logger.log(`🤖 开始生成押题部分...`);
      this.emitProgress(
        progressSubject,
        15,
        '🤖 AI 正在理解您的简历内容并生成面试问题...',
      );

      this.getStagePrompt(progressSubject);

      // ===== 第一步：生成押题部分（问题 + 综合评估）10-50% =====
      const questionsResult =
        await this.aiService.generateResumeQuizQuestionsOnly({
          company: dto?.company || '',
          positionName: dto.positionName,
          minSalary: dto.minSalary,
          maxSalary: dto.maxSalary,
          jd: dto.jd,
          resumeContent,
        });

      this.logger.log(
        `✅ 押题部分生成完成: 问题数=${questionsResult.questions?.length || 0}`,
      );

      this.emitProgress(
        progressSubject,
        50,
        '✅ 面试问题生成完成，开始分析匹配度...',
      );
      // ===== 第二步：生成匹配度分析部分，后续不在需要记录进度 =====
      this.logger.log(`🤖 开始生成匹配度分析...`);
      this.emitProgress(
        progressSubject,
        60,
        '🤖 AI 正在分析您与岗位的匹配度...',
      );

      const analysisResult =
        await this.aiService.generateResumeQuizAnalysisOnly({
          company: dto?.company || '',
          positionName: dto.positionName,
          minSalary: dto.minSalary,
          maxSalary: dto.maxSalary,
          jd: dto.jd,
          resumeContent,
        });

      this.logger.log(`✅ 匹配度分析完成`);

      const aiDuration = Date.now() - aiStartTime;
      this.logger.log(
        `⏱️ AI 总耗时: ${aiDuration}ms (${(aiDuration / 1000).toFixed(1)}秒)`,
      );
      // 合并两部分结果
      const aiResult = {
        ...questionsResult,
        ...analysisResult,
      };

      // ========== 阶段 3: 保存结果阶段==========
      const quizResult = await this.resumeQuizResultModel.create({
        resultId,
        user: new Types.ObjectId(userId),
        userId,
        resumeId: dto.resumeId,
        company: dto?.company || '',
        position: dto.positionName,
        jobDescription: dto.jd,
        questions: aiResult.questions,
        totalQuestions: aiResult.questions.length,
        summary: aiResult.summary,
        // AI生成的分析报告数据
        matchScore: aiResult.matchScore,
        matchLevel: aiResult.matchLevel,
        matchedSkills: aiResult.matchedSkills,
        missingSkills: aiResult.missingSkills,
        knowledgeGaps: aiResult.knowledgeGaps,
        learningPriorities: aiResult.learningPriorities,
        radarData: aiResult.radarData,
        strengths: aiResult.strengths,
        weaknesses: aiResult.weaknesses,
        interviewTips: aiResult.interviewTips,
        // 元数据
        consumptionRecordId: recordId,
        aiModel: 'deepseek-chat',
        promptVersion: dto.promptVersion || 'v2',
      });

      this.logger.log(`✅ 结果保存成功: resultId=${resultId}`);

      // 更新消费记录为成功
      await this.consumptionRecordModel.findByIdAndUpdate(
        consumptionRecord._id,
        {
          $set: {
            status: ConsumptionStatus.SUCCESS,
            outputData: {
              resultId,
              questionCount: aiResult.questions.length,
            },
            aiModel: 'deepseek-chat',
            promptTokens: aiResult.usage?.promptTokens,
            completionTokens: aiResult.usage?.completionTokens,
            totalTokens: aiResult.usage?.totalTokens,
            completedAt: new Date(),
          },
        },
      );

      this.logger.log(
        `✅ 消费记录已更新为成功状态: recordId=${consumptionRecord.recordId}`,
      );
      // ========== 阶段 4: 返回结果==========
      const result = {
        resultId: `result-${Date.now()}`, // 临时ID，后面会存到数据库
        questions: questionsResult.questions,
        summary: questionsResult.summary,
        // 匹配度分析数据
        matchScore: analysisResult.matchScore,
        matchLevel: analysisResult.matchLevel,
        matchedSkills: analysisResult.matchedSkills,
        missingSkills: analysisResult.missingSkills,
        knowledgeGaps: analysisResult.knowledgeGaps,
        learningPriorities: analysisResult.learningPriorities,
        radarData: analysisResult.radarData,
        strengths: analysisResult.strengths,
        weaknesses: analysisResult.weaknesses,
        interviewTips: analysisResult.interviewTips,
      };

      // 发送完成事件
      this.emitProgress(
        progressSubject,
        100,
        `✅ 所有分析完成，正在保存结果...响应数据为${JSON.stringify(result)}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ 简历押题生成失败: userId=${userId}, error=${error.message}`,
        error.stack,
      );

      // ========== 失败回滚流程 ==========
      try {
        // 1. 返还次数（最重要！）
        this.logger.log(`🔄 开始退还次数: userId=${userId}`);
        await this.refundCount(userId, 'resume');
        this.logger.log(`✅ 次数退还成功: userId=${userId}`);

        // 2. 更新消费记录为失败
        if (consumptionRecord) {
          await this.consumptionRecordModel.findByIdAndUpdate(
            consumptionRecord._id,
            {
              $set: {
                status: ConsumptionStatus.FAILED, // 标记为失败
                errorMessage: error.message, // 记录错误信息
                errorStack:
                  process.env.NODE_ENV === 'development'
                    ? error.stack // 开发环境记录堆栈
                    : undefined, // 生产环境不记录（隐私考虑）
                failedAt: new Date(),
                isRefunded: true, // ← 标记为已退款
                refundedAt: new Date(),
              },
            },
          );
          this.logger.log(
            `✅ 消费记录已更新为失败状态: recordId=${consumptionRecord.recordId}`,
          );
        }
      } catch (refundError) {
        // ⚠️ 退款失败是严重问题，需要人工介入！
        this.logger.error(
          `🚨 退款流程失败！这是严重问题，需要人工介入！` +
            `userId=${userId}, ` +
            `originalError=${error.message}, ` +
            `refundError=${refundError.message}`,
          refundError.stack,
        );

        // TODO: 这里应该发送告警通知（钉钉、邮件等）
        // await this.alertService.sendCriticalAlert({
        //   type: 'REFUND_FAILED',
        //   userId,
        //   error: refundError.message,
        // });
      }

      // 3. 发送错误事件给前端
      if (progressSubject && !progressSubject.closed) {
        progressSubject.next({
          type: 'error',
          progress: 0,
          label: '❌ 生成失败',
          error: error,
        });
        progressSubject.complete();
      }

      throw error;
    }
  }

  /**
   * 退还次数
   * ⚠️ 关键方法：确保在任何失败情况下都能正确退还用户次数
   */
  private async refundCount(
    userId: string,
    type: 'resume' | 'special' | 'behavior',
  ): Promise<void> {
    const field =
      type === 'resume'
        ? 'resumeRemainingCount'
        : type === 'special'
          ? 'specialRemainingCount'
          : 'behaviorRemainingCount';

    // 使用原子操作退还次数
    const result = await this.userModel.findByIdAndUpdate(
      userId,
      {
        $inc: { [field]: 1 },
      },
      { new: true }, // 返回更新后的文档
    );

    // 验证退款是否成功
    if (!result) {
      throw new Error(`退款失败：用户不存在 userId=${userId}`);
    }

    this.logger.log(
      `✅ 次数退还成功: userId=${userId}, type=${type}, 退还后=${result[field]}`,
    );
  }

  /**
   * 发送进度事件
   * @param subject 进度 Subject
   * @param progress 进度百分比 (0-100)
   * @param label 进度提示文本
   * @param stage 当前阶段
   */
  private emitProgress(
    subject: Subject<ProgressEvent> | undefined,
    progress: number,
    label: string,
    stage?: 'prepare' | 'generating' | 'saving' | 'done',
  ): void {
    if (subject && !subject.closed) {
      subject.next({
        type: 'progress',
        progress: Math.min(Math.max(progress, 0), 100), // 确保在 0-100 范围内
        label,
        message: label,
        stage,
      });
    }
  }

  /**
   * 获取剩余次数
   * resume： 简历押题
   * special：专项面试
   * behavior：HR + 行测面试
   */
  private async getRemainingCount(
    userId: string,
    type: 'resume' | 'special' | 'behavior',
  ): Promise<number> {
    const user = await this.userModel.findById(userId);
    if (!user) return 0;

    switch (type) {
      case 'resume':
        return user.resumeRemainingCount;
      case 'special':
        return user.specialRemainingCount;
      case 'behavior':
        return user.behaviorRemainingCount;
      default:
        return 0;
    }
  }

  /**
   * 不同阶段的提示信息
   */
  private getStagePrompt(
    progressSubject: Subject<ProgressEvent> | undefined,
  ): void {
    if (!progressSubject) return;
    // 定义不同阶段的提示信息
    const progressMessages = [
      // 0-20%: 理解阶段
      { progress: 0.05, message: '🤖 AI 正在深度理解您的简历内容...' },
      { progress: 0.1, message: '📊 AI 正在分析您的技术栈和项目经验...' },
      { progress: 0.15, message: '🔍 AI 正在识别您的核心竞争力...' },
      { progress: 0.2, message: '📋 AI 正在对比岗位要求与您的背景...' },

      // 20-50%: 设计问题阶段
      { progress: 0.25, message: '💡 AI 正在设计针对性的技术问题...' },
      { progress: 0.3, message: '🎯 AI 正在挖掘您简历中的项目亮点...' },
      { progress: 0.35, message: '🧠 AI 正在构思场景化的面试问题...' },
      { progress: 0.4, message: '⚡ AI 正在设计不同难度的问题组合...' },
      { progress: 0.45, message: '🔬 AI 正在分析您的技术深度和广度...' },
      { progress: 0.5, message: '📝 AI 正在生成基于 STAR 法则的答案...' },

      // 50-70%: 优化阶段
      { progress: 0.55, message: '✨ AI 正在优化问题的表达方式...' },
      { progress: 0.6, message: '🎨 AI 正在为您准备回答要点和技巧...' },
      { progress: 0.65, message: '💎 AI 正在提炼您的项目成果和亮点...' },
      { progress: 0.7, message: '🔧 AI 正在调整问题难度分布...' },

      // 70-85%: 完善阶段
      { progress: 0.75, message: '📚 AI 正在补充技术关键词和考察点...' },
      { progress: 0.8, message: '🎓 AI 正在完善综合评估建议...' },
      { progress: 0.85, message: '🚀 AI 正在做最后的质量检查...' },
      { progress: 0.9, message: '✅ AI 即将完成问题生成...' },
    ];

    // 模拟一个定时器：每间隔一秒，响应一次数据
    let progress = 0;
    let currentMessage = progressMessages[0];
    const interval = setInterval(
      () => {
        progress += 1;
        currentMessage = progressMessages[progress];
        // 发送进度事件
        this.emitProgress(
          progressSubject,
          progress,
          currentMessage.message,
          'generating',
        );
        // 简单处理，到了 progressMessages 的 length 就结束了
        if (progress === progressMessages.length - 1) {
          clearInterval(interval);
          this.emitProgress(progressSubject, 100, 'AI 已完成问题生成', 'done');
          return {
            questions: [],
            analysis: [],
          };
        }
      },
      Math.floor(Math.random() * (2000 - 800 + 1)) + 800, // 每 0.8-2 秒更新一次
    );
  }

  /**
   * 提取简历内容
   * 支持三种方式：直接文本、结构化简历、上传文件
   */
  private async extractResumeContent(
    userId: string,
    dto: ResumeQuizDto,
  ): Promise<string> {
    // 优先级 1：如果直接提供了简历文本，使用它
    if (dto.resumeContent) {
      this.logger.log(
        `✅ 使用直接提供的简历文本，长度=${dto.resumeContent.length}字符`,
      );
      return dto.resumeContent;
    }

    // 优先级 2：如果提供了 resumeId，尝试查询
    // 之前 ResumeQuizDto 中没有创建 resumeURL 的属性，所以这里需要在 ResumeQuizDto 中补充以下 resumeURL
    if (dto.resumeURL) {
      try {
        // 1. 从 URL 下载文件
        const rawText = await this.documentParserService.parseDocumentFromUrl(
          dto.resumeURL,
        );

        // 2. 清理文本（移除格式化符号等）
        const cleanedText = this.documentParserService.cleanText(rawText);

        // 3. 验证内容质量
        const validation =
          this.documentParserService.validateResumeContent(cleanedText);

        if (!validation.isValid) {
          throw new BadRequestException(validation.reason);
        }

        // 4. 记录任何警告
        if (validation.warnings && validation.warnings.length > 0) {
          this.logger.warn(`简历解析警告: ${validation.warnings.join('; ')}`);
        }

        // 5. 检查内容长度（避免超长内容）
        const estimatedTokens =
          this.documentParserService.estimateTokens(cleanedText);

        if (estimatedTokens > 6000) {
          this.logger.warn(
            `简历内容过长: ${estimatedTokens} tokens，将进行截断`,
          );
          // 截取前 6000 tokens 对应的字符
          const maxChars = 6000 * 1.5; // 约 9000 字符
          const truncatedText = cleanedText.substring(0, maxChars);

          this.logger.log(
            `简历已截断: 原长度=${cleanedText.length}, ` +
              `截断后=${truncatedText.length}, ` +
              `tokens≈${this.documentParserService.estimateTokens(truncatedText)}`,
          );

          return truncatedText;
        }

        this.logger.log(
          `✅ 简历解析成功: 长度=${cleanedText.length}字符, ` +
            `tokens≈${estimatedTokens}`,
        );

        return cleanedText;
      } catch (error) {
        // 文件解析失败，返回友好的错误信息
        if (error instanceof BadRequestException) {
          throw error;
        }

        this.logger.error(
          `❌ 解析简历文件失败: resumeId=${dto.resumeId}, error=${error.message}`,
          error.stack,
        );

        throw new BadRequestException(
          `简历文件解析失败: ${error.message}。` +
            `建议：确保上传的是文本型 PDF 或 DOCX 文件，未加密且未损坏。` +
            `或者直接粘贴简历文本。`,
        );
      }
    }

    // 都没提供，返回错误
    throw new BadRequestException('请提供简历URL或简历内容');
  }

  /**
   * 开始模拟面试（流式响应）
   * @param userId 用户ID
   * @param dto 请求参数
   * @returns Subject 流式事件
   */
  startMockInterviewWithStream(
    userId: string,
    dto: StartMockInterviewDto,
  ): Subject<MockInterviewEventDto> {
    const subject = new Subject<MockInterviewEventDto>();

    // 异步执行
    this.executeStartMockInterview(userId, dto, subject).catch((error) => {
      this.logger.error(`模拟面试启动失败: ${error.message}`, error.stack);
      if (subject && !subject.closed) {
        subject.next({
          type: MockInterviewEventType.ERROR,
          error: error,
        });
        subject.complete();
      }
    });

    return subject;
  }

  /**
   * 执行开始模拟面试
   * 该方法用于启动一场模拟面试，包括检查用户的剩余次数、生成面试开场白、创建面试会话、记录消费记录，并实时向前端推送面试进度。
   * 它包括以下几个主要步骤：
   * 1. 扣除用户模拟面试次数；
   * 2. 提取简历内容；
   * 3. 创建会话并生成相关记录；
   * 4. 流式生成面试开场白，并逐块推送到前端；
   * 5. 保存面试开场白到数据库；
   * 6. 处理失败时的退款操作。
   *
   * @param userId - 用户ID，表示正在进行面试的用户。
   * @param dto - 启动模拟面试的详细数据，包括面试类型、简历ID、职位信息等。
   * @param progressSubject - 用于实时推送面试进度的`Subject`对象，前端通过它接收流式数据。
   *
   * @returns Promise<void> - 返回一个 `Promise`，表示模拟面试的启动过程（包含异步操作）。
   */
  private async executeStartMockInterview(
    userId: string,
    dto: StartMockInterviewDto,
    progressSubject: Subject<MockInterviewEventDto>,
  ): Promise<void> {
    try {
      // 1. 检查并扣除次数
      // 根据面试类型选择扣费字段
      const countField =
        dto.interviewType === MockInterviewType.SPECIAL
          ? 'specialRemainingCount'
          : 'behaviorRemainingCount';

      // 查找用户并确保剩余次数足够
      const user = await this.userModel.findOneAndUpdate(
        {
          _id: userId,
          [countField]: { $gt: 0 },
        },
        {
          $inc: { [countField]: -1 }, // 扣除一次模拟面试的次数
        },
        { new: false },
      );

      // 如果用户没有足够的次数，抛出异常
      if (!user) {
        throw new BadRequestException(
          `${dto.interviewType === MockInterviewType.SPECIAL ? '专项面试' : '综合面试'}次数不足，请前往充值页面购买`,
        );
      }

      this.logger.log(
        `✅ 用户扣费成功: userId=${userId}, type=${dto.interviewType}, 扣费前=${user[countField]}, 扣费后=${user[countField] - 1}`,
      );

      // 2. 提取简历内容
      // 提取用户简历内容
      const resumeContent = await this.extractResumeContent(userId, {
        resumeId: dto.resumeId,
        resumeContent: dto.resumeContent,
      } as any);

      // 3. 创建会话
      // 为每个面试生成唯一的会话ID
      const sessionId = uuidv4();
      const interviewerName = '面试官（张三老师）';
      // 设定面试的目标时长
      const targetDuration =
        dto.interviewType === MockInterviewType.SPECIAL
          ? this.SPECIAL_INTERVIEW_MAX_DURATION // 120 分钟
          : this.BEHAVIOR_INTERVIEW_MAX_DURATION; // 120 分钟

      // 根据工资范围生成工资区间
      const salaryRange =
        dto.minSalary && dto.maxSalary
          ? `${dto.minSalary}K-${dto.maxSalary}K`
          : dto.minSalary
            ? `${dto.minSalary}K起`
            : dto.maxSalary
              ? `${dto.maxSalary}K封顶`
              : undefined;

      // 创建面试会话对象
      const session: InterviewSession = {
        sessionId,
        userId,
        interviewType: dto.interviewType,
        interviewerName,
        candidateName: dto.candidateName,
        company: dto.company || '',
        positionName: dto.positionName,
        salaryRange,
        jd: dto.jd,
        resumeContent,
        conversationHistory: [],
        questionCount: 0,
        startTime: new Date(),
        targetDuration,
        isActive: true,
      };

      // 将会话保存到内存中的会话池
      this.interviewSessions.set(sessionId, session);

      // 4. 创建数据库记录并生成 resultId
      const resultId = uuidv4();
      const recordId = uuidv4();

      // 为会话分配 resultId 和消费记录ID
      session.resultId = resultId;
      session.consumptionRecordId = recordId;

      // 保存面试结果记录到数据库
      await this.aiInterviewResultModel.create({
        resultId,
        user: new Types.ObjectId(userId),
        userId,
        interviewType:
          dto.interviewType === MockInterviewType.SPECIAL
            ? 'special'
            : 'behavior',
        company: dto.company || '',
        position: dto.positionName,
        salaryRange,
        jobDescription: dto.jd,
        interviewMode: 'text',
        qaList: [],
        totalQuestions: 0,
        answeredQuestions: 0,
        status: 'in_progress',
        consumptionRecordId: recordId,
        sessionState: session, // 保存会话状态
        metadata: {
          interviewerName,
          candidateName: dto.candidateName,
          sessionId,
        },
      });

      // 创建消费记录
      await this.consumptionRecordModel.create({
        resultId,
        recordId,
        user: new Types.ObjectId(userId),
        userId,
        type:
          dto.interviewType === MockInterviewType.SPECIAL
            ? ConsumptionType.SPECIAL_INTERVIEW
            : ConsumptionType.BEHAVIOR_INTERVIEW,
        status: ConsumptionStatus.SUCCESS,
        consumedCount: 1,
        description: `模拟面试 - ${dto.interviewType === MockInterviewType.SPECIAL ? '专项面试' : '综合面试'}`,
        inputData: {
          company: dto.company || '',
          position: dto.positionName,
          interviewType: dto.interviewType,
        },
        outputData: {
          resultId,
          sessionId,
        },
        startedAt: session.startTime,
      });

      this.logger.log(
        `✅ 面试会话创建成功: sessionId=${sessionId}, resultId=${resultId}, interviewer=${interviewerName}`,
      );

      // ✅ ===== 关键部分：流式生成开场白 =====

      // 5. 流式生成开场白
      let fullOpeningStatement = '';
      const openingGenerator = this.aiService.generateOpeningStatementStream(
        interviewerName,
        dto.candidateName,
        dto.positionName,
      );

      // 逐块推送开场白
      for await (const chunk of openingGenerator) {
        fullOpeningStatement += chunk;

        // 发送流式事件
        progressSubject.next({
          type: MockInterviewEventType.START,
          sessionId,
          resultId, // ✅ 包含 resultId
          interviewerName,
          content: fullOpeningStatement, // 累积内容
          questionNumber: 0,
          totalQuestions:
            dto.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
          elapsedMinutes: 0,
          isStreaming: true, // 标记为流式传输中
        });
      }

      // 记录开场白生成时间
      const openingStatementTime = new Date();

      // 6. 记录到对话历史
      session.conversationHistory.push({
        role: 'interviewer',
        content: fullOpeningStatement,
        timestamp: openingStatementTime,
      });

      // 保存开场白到数据库 qaList
      await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId },
        {
          $push: {
            qaList: {
              question: fullOpeningStatement,
              answer: '', // 开场白没有用户回答
              answerDuration: 0,
              answeredAt: openingStatementTime,
              askedAt: openingStatementTime, // ✅ 记录提问时间
            },
          },
          $set: {
            sessionState: session, // 更新会话状态
          },
        },
      );

      this.logger.log(`📝 开场白已保存到数据库: resultId=${resultId}`);

      // 7. 发送最终开场白事件（标记流式完成）
      progressSubject.next({
        type: MockInterviewEventType.START,
        sessionId,
        resultId, // ✅ 包含 resultId
        interviewerName,
        content: fullOpeningStatement,
        questionNumber: 0,
        totalQuestions:
          dto.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
        elapsedMinutes: 0,
        isStreaming: false, // 流式传输完成
      });

      // 8. 发送等待事件
      progressSubject.next({
        type: MockInterviewEventType.WAITING,
        sessionId,
      });

      progressSubject.complete();
    } catch (error) {
      // 失败时退还次数
      const countField =
        dto.interviewType === MockInterviewType.SPECIAL
          ? 'special'
          : 'behavior';
      await this.refundCount(userId, countField as any);
      throw error;
    }
  }

  /**
   * 处理候选人回答（流式响应）
   * @param userId 用户ID
   * @param sessionId 会话ID
   * @param answer 候选人回答
   * @returns Subject 流式事件
   */
  answerMockInterviewWithStream(
    userId: string,
    sessionId: string,
    answer: string,
  ): Subject<MockInterviewEventDto> {
    const subject = new Subject<MockInterviewEventDto>();

    // 异步执行
    this.executeAnswerMockInterview(userId, sessionId, answer, subject).catch(
      (error) => {
        this.logger.error(`处理面试回答失败: ${error.message}`, error.stack);
        if (subject && !subject.closed) {
          subject.next({
            type: MockInterviewEventType.ERROR,
            error: error,
          });
          subject.complete();
        }
      },
    );
    return subject;
  }

  /**
   * 执行处理候选人回答
   * @param userId 用户ID
   * @param sessionId 会话ID
   * @param answer 候选人回答
   * @param progressSubject 用于实时推送面试进度的`Subject`对象，前端通过它接收流式数据。
   * @returns Promise<void> - 返回一个 `Promise`，表示处理候选人回答的过程（包含异步操作）。
   */
  private async executeAnswerMockInterview(
    userId: string,
    sessionId: string,
    answer: string,
    progressSubject: Subject<MockInterviewEventDto>,
  ): Promise<void> {
    try {
      // 1. 获取会话
      const session = this.interviewSessions.get(sessionId);

      if (!session) {
        throw new NotFoundException('面试会话不存在或已过期');
      }

      if (session.userId !== userId) {
        throw new BadRequestException('无权访问此面试会话');
      }

      if (!session.isActive) {
        throw new BadRequestException('面试会话已结束');
      }

      // 2. 记录候选人回答
      session.conversationHistory.push({
        role: 'candidate',
        content: answer,
        timestamp: new Date(),
      });

      session.questionCount++;

      // 3. 计算已用时间
      const elapsedMinutes = Math.floor(
        (Date.now() - session.startTime.getTime()) / 1000 / 60,
      );

      this.logger.log(`当前面试用时：${elapsedMinutes}分钟`);

      this.logger.log(
        `📝 候选人回答: sessionId=${sessionId}, questionCount=${session.questionCount}, elapsed=${elapsedMinutes}min`,
      );

      // 3.1 检查是否超时，需要强制结束面试
      const maxDuration =
        session.interviewType === MockInterviewType.SPECIAL
          ? this.SPECIAL_INTERVIEW_MAX_DURATION
          : this.BEHAVIOR_INTERVIEW_MAX_DURATION;

      if (elapsedMinutes >= maxDuration) {
        this.logger.log(
          `⏰ 面试超时，强制结束: sessionId=${sessionId}, elapsed=${elapsedMinutes}min, max=${maxDuration}min`,
        );

        // 面试结束
        session.isActive = false;

        // 添加结束语
        const closingStatement = `感谢您今天的面试表现。由于时间关系（已进行${elapsedMinutes}分钟），我们今天的面试就到这里。您的回答让我们对您有了较为全面的了解，后续我们会进行综合评估，有结果会及时通知您。祝您生活愉快！`;

        session.conversationHistory.push({
          role: 'interviewer',
          content: closingStatement,
          timestamp: new Date(),
        });

        // 保存面试结果
        const resultId = await this.saveMockInterviewResult(session);

        // 发送结束事件
        progressSubject.next({
          type: MockInterviewEventType.END,
          sessionId,
          content: closingStatement,
          resultId,
          elapsedMinutes,
          isStreaming: false,
          metadata: {
            totalQuestions: session.questionCount,
            interviewerName: session.interviewerName,
            reason: 'timeout', // 标记为超时结束
          },
        });

        // TODO: 异步生成评估报告（不阻塞返回）

        // 清理会话（延迟清理）
        setTimeout(
          () => {
            this.interviewSessions.delete(sessionId);
            this.logger.log(`🗑️ 会话已清理: sessionId=${sessionId}`);
          },
          5 * 60 * 1000,
        );

        progressSubject.complete();
        return; // 提前返回，不再继续生成下一个问题
      }

      // 4. 发送思考中事件
      progressSubject.next({
        type: MockInterviewEventType.THINKING,
        sessionId,
      });

      // 5. 流式生成下一个问题
      const questionStartTime = new Date(); // ✅ 记录问题开始生成的时间
      let fullQuestion = '';
      let aiResponse: {
        question: string;
        shouldEnd: boolean;
        standardAnswer?: string;
        reasoning?: string;
      };

      const questionGenerator = this.aiService.generateInterviewQuestionStream({
        interviewType:
          session.interviewType === MockInterviewType.SPECIAL
            ? 'special'
            : 'comprehensive',
        resumeContent: session.resumeContent,
        company: session.company || '',
        positionName: session.positionName,
        jd: session.jd,
        conversationHistory: session.conversationHistory.map((h) => ({
          role: h.role,
          content: h.content,
        })),
        elapsedMinutes,
        targetDuration: session.targetDuration,
      });

      // 逐块推送问题内容，并捕获返回值
      let hasStandardAnswer = false; // 标记是否已检测到标准答案
      let questionOnlyContent = ''; // 只包含问题的内容
      let standardAnswerContent = ''; // 标准答案内容

      try {
        let result = await questionGenerator.next();
        while (!result.done) {
          const chunk = result.value;
          fullQuestion += chunk;

          // 检测是否包含标准答案标记
          const standardAnswerIndex = fullQuestion.indexOf('[STANDARD_ANSWER]');

          if (standardAnswerIndex !== -1) {
            // 检测到标准答案标记
            if (!hasStandardAnswer) {
              // 第一次检测到，提取问题部分
              questionOnlyContent = fullQuestion
                .substring(0, standardAnswerIndex)
                .trim();
              hasStandardAnswer = true;

              // 发送最终问题内容（标记流式完成）
              progressSubject.next({
                type: MockInterviewEventType.QUESTION,
                sessionId,
                interviewerName: session.interviewerName,
                content: questionOnlyContent,
                questionNumber: session.questionCount,
                totalQuestions:
                  session.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
                elapsedMinutes,
                isStreaming: false, // ✅ 标记流式传输完成
              });

              // 立即发送等待事件，告诉前端问题已结束
              progressSubject.next({
                type: MockInterviewEventType.WAITING,
                sessionId,
              });

              this.logger.log(
                `✅ 问题生成完成，进入参考答案生成阶段: questionLength=${questionOnlyContent.length}`,
              );
            }

            // 提取并流式推送参考答案
            const currentStandardAnswer = fullQuestion
              .substring(standardAnswerIndex + '[STANDARD_ANSWER]'.length)
              .trim();

            if (currentStandardAnswer.length > standardAnswerContent.length) {
              standardAnswerContent = currentStandardAnswer;

              // 流式推送参考答案
              progressSubject.next({
                type: MockInterviewEventType.REFERENCE_ANSWER,
                sessionId,
                interviewerName: session.interviewerName,
                content: standardAnswerContent,
                questionNumber: session.questionCount,
                totalQuestions:
                  session.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
                elapsedMinutes,
                isStreaming: true, // 标记为流式传输中
              });
            }
          } else {
            // 还在生成问题阶段，继续推送
            progressSubject.next({
              type: MockInterviewEventType.QUESTION,
              sessionId,
              interviewerName: session.interviewerName,
              content: fullQuestion,
              questionNumber: session.questionCount,
              totalQuestions:
                session.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
              elapsedMinutes,
              isStreaming: true, // 标记为流式传输中
            });
          }

          result = await questionGenerator.next();
        }

        // Generator 完成后，发送参考答案的最终状态
        if (hasStandardAnswer && standardAnswerContent) {
          progressSubject.next({
            type: MockInterviewEventType.REFERENCE_ANSWER,
            sessionId,
            interviewerName: session.interviewerName,
            content: standardAnswerContent,
            questionNumber: session.questionCount,
            totalQuestions:
              session.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
            elapsedMinutes,
            isStreaming: false, // ✅ 标记流式传输完成
          });
        }

        // Generator 完成，result.value 现在是返回值
        aiResponse = result.value;

        // 如果没有检测到标准答案标记（可能AI没有生成），使用完整内容
        if (!hasStandardAnswer) {
          questionOnlyContent = fullQuestion;
          this.logger.warn(`⚠️ 未检测到标准答案标记，使用完整内容作为问题`);
        }
      } catch (error) {
        // 如果生成器抛出错误，直接抛出
        throw error;
      }

      // 6. 确保 session.resultId 存在
      if (!session.resultId) {
        this.logger.error(
          `❌ session.resultId 不存在，无法保存数据: sessionId=${sessionId}`,
        );
        throw new Error('session.resultId 不存在，无法保存数据');
      }

      // 7. 【步骤1】保存上一轮的问答（更新用户回答）
      // 在 conversationHistory 中：
      // - length - 1: 刚 push 的用户回答
      // - length - 2: 上一个面试官问题（用户回答的这个问题）
      if (session.conversationHistory.length >= 2) {
        const userAnswerIndex = session.conversationHistory.length - 1;
        const prevQuestionIndex = session.conversationHistory.length - 2;

        const prevQuestion = session.conversationHistory[prevQuestionIndex];
        const userAnswer = session.conversationHistory[userAnswerIndex];

        // 检查是否是开场白（开场白是第一条面试官消息，索引为0）
        const isOpeningStatement = prevQuestionIndex === 0;

        if (
          prevQuestion.role === 'interviewer' &&
          userAnswer.role === 'candidate'
        ) {
          if (isOpeningStatement) {
            // 更新开场白的用户回答
            await this.updateInterviewAnswer(
              session.resultId,
              0, // 开场白是第一项
              userAnswer.content,
              userAnswer.timestamp,
              session, // 传递 session 用于更新 sessionState
            );
          } else {
            // 更新上一个问题的用户回答
            const qaIndex = session.questionCount - 1; // qaList 中的索引
            await this.updateInterviewAnswer(
              session.resultId,
              qaIndex,
              userAnswer.content,
              userAnswer.timestamp,
              session, // 传递 session 用于更新 sessionState
            );
          }
        }
      }

      // 8. 【步骤2】在AI开始生成前，先创建占位项
      // 查询当前 qaList 的长度以确定新问题的索引
      const dbRecord = await this.aiInterviewResultModel.findOne({
        resultId: session.resultId,
      });
      const newQAIndex = dbRecord?.qaList?.length || 0; // 新问题的索引

      await this.createInterviewQuestionPlaceholder(
        session.resultId,
        questionStartTime,
      );

      // 9. 记录AI生成的新问题（包含标准答案）到内存
      session.conversationHistory.push({
        role: 'interviewer',
        content: aiResponse.question,
        timestamp: questionStartTime, // ✅ 使用问题开始生成时的时间
        standardAnswer: aiResponse.standardAnswer, // 保存标准答案
      });

      // 10. 【步骤3】AI问题生成完成后，更新占位项的问题内容
      await this.updateInterviewQuestion(
        session.resultId,
        newQAIndex,
        aiResponse.question,
        questionStartTime,
      );

      // 11. 【步骤4】AI标准答案生成完成后，更新标准答案
      if (aiResponse.standardAnswer) {
        await this.updateInterviewStandardAnswer(
          session.resultId,
          newQAIndex,
          aiResponse.standardAnswer,
        );
      }

      // 12. 更新 sessionState 到数据库
      await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId: session.resultId },
        {
          $set: {
            sessionState: session, // 同步会话状态
          },
        },
      );

      // 12. 判断是否结束面试
      if (aiResponse.shouldEnd) {
        // 面试结束
        session.isActive = false;

        // 保存面试结果
        const resultId = await this.saveMockInterviewResult(session);

        // 发送结束事件（标记流式完成）
        progressSubject.next({
          type: MockInterviewEventType.END,
          sessionId,
          content: aiResponse.question,
          resultId,
          elapsedMinutes,
          isStreaming: false, // 流式传输完成
          metadata: {
            totalQuestions: session.questionCount,
            interviewerName: session.interviewerName,
          },
        });

        // 清理会话（延迟清理，给前端一些时间获取结果）
        setTimeout(
          () => {
            this.interviewSessions.delete(sessionId);
            this.logger.log(`🗑️ 会话已清理: sessionId=${sessionId}`);
          },
          5 * 60 * 1000,
        ); // 5分钟后清理
      } else {
        // 继续面试 - 如果没有检测到标准答案，发送最终问题事件
        if (!hasStandardAnswer) {
          progressSubject.next({
            type: MockInterviewEventType.QUESTION,
            sessionId,
            interviewerName: session.interviewerName,
            content: aiResponse.question,
            questionNumber: session.questionCount,
            totalQuestions:
              session.interviewType === MockInterviewType.SPECIAL ? 12 : 8,
            elapsedMinutes,
            isStreaming: false, // 流式传输完成
          });

          // 发送等待事件
          progressSubject.next({
            type: MockInterviewEventType.WAITING,
            sessionId,
          });
        }
        // 注意：如果已经检测到标准答案，前面已经发送过 isStreaming: false 和 WAITING 事件了
      }

      progressSubject.complete();
    } catch (error) {
      throw error;
    }
  }

  /**
   * 保存模拟面试结果（面试结束时调用）
   * 如果已经通过实时保存创建了记录，则直接返回 resultId。
   * 该方法的主要功能是根据面试会话保存最终的面试结果到数据库，并生成相关的消费记录。
   *
   * @param session - 面试会话对象，包含了此次模拟面试的所有信息，包括面试类型、会话状态、对话历史等。
   *
   * @returns Promise<string> - 返回面试结果ID（resultId），标识当前模拟面试的唯一结果。
   */
  private async saveMockInterviewResult(
    session: InterviewSession,
  ): Promise<string> {
    try {
      // 如果已经有 resultId（通过实时保存创建），直接返回
      if (session.resultId) {
        this.logger.log(
          `✅ 使用已有的结果ID: resultId=${session.resultId}（已通过实时保存）`,
        );

        // 更新面试结果和消费记录为完成状态
        await this.aiInterviewResultModel.findOneAndUpdate(
          { resultId: session.resultId },
          {
            $set: {
              status: 'completed', // 更新为已完成状态
              completedAt: new Date(), // 设置完成时间
              sessionState: session, // 保存最终会话状态（包括结束语）
            },
          },
        );

        // 如果有消费记录ID，更新消费记录的状态为成功
        if (session.consumptionRecordId) {
          await this.consumptionRecordModel.findOneAndUpdate(
            { recordId: session.consumptionRecordId },
            {
              $set: {
                completedAt: new Date(), // 设置消费记录完成时间
                status: ConsumptionStatus.SUCCESS, // 标记消费状态为成功
              },
            },
          );
        }

        return session.resultId; // 如果有 resultId，直接返回
      }

      // 如果没有 resultId（没有启用实时保存或出错），使用原有逻辑创建完整记录
      const resultId = uuidv4(); // 生成新的 resultId
      const recordId = uuidv4(); // 生成新的消费记录ID

      // 构建问答列表（包含标准答案）
      const qaList: any[] = [];
      for (let i = 0; i < session.conversationHistory.length; i += 2) {
        if (i + 1 < session.conversationHistory.length) {
          qaList.push({
            question: session.conversationHistory[i].content, // 问题内容
            answer: session.conversationHistory[i + 1].content, // 答案内容
            standardAnswer: session.conversationHistory[i].standardAnswer, // 标准答案（如果有）
            answerDuration: 0, // 文字面试无法准确计算答题时间
            answeredAt: session.conversationHistory[i + 1].timestamp, // 答题时间
          });
        }
      }

      // 计算面试时长（分钟）
      const durationMinutes = Math.floor(
        (Date.now() - session.startTime.getTime()) / 1000 / 60, // 转换为分钟
      );

      // 创建面试结果记录
      await this.aiInterviewResultModel.create({
        resultId,
        user: new Types.ObjectId(session.userId),
        userId: session.userId,
        interviewType:
          session.interviewType === MockInterviewType.SPECIAL
            ? 'special'
            : 'behavior',
        company: session.company || '', // 公司名称
        position: session.positionName, // 职位名称
        salaryRange: session.salaryRange, // 工资范围
        jobDescription: session.jd, // 职位描述
        interviewDuration: durationMinutes, // 面试时长
        interviewMode: 'text', // 模拟面试的模式（文字）
        qaList, // 问答列表
        totalQuestions: qaList.length, // 总问题数
        answeredQuestions: qaList.length, // 已回答问题数
        status: 'completed', // 设置为完成状态
        completedAt: new Date(), // 设置完成时间
        consumptionRecordId: recordId, // 消费记录ID
        metadata: {
          interviewerName: session.interviewerName, // 面试官姓名
          candidateName: session.candidateName, // 候选人姓名
        },
      });

      // 创建消费记录
      await this.consumptionRecordModel.create({
        recordId,
        user: new Types.ObjectId(session.userId),
        userId: session.userId,
        type:
          session.interviewType === MockInterviewType.SPECIAL
            ? ConsumptionType.SPECIAL_INTERVIEW
            : ConsumptionType.BEHAVIOR_INTERVIEW,
        status: ConsumptionStatus.SUCCESS, // 消费状态成功
        consumedCount: 1, // 消费次数
        description: `模拟面试 - ${session.interviewType === MockInterviewType.SPECIAL ? '专项面试' : '综合面试'}`, // 描述
        inputData: {
          company: session.company || '',
          positionName: session.positionName,
          interviewType: session.interviewType,
        },
        outputData: {
          resultId,
          questionCount: qaList.length, // 问题数量
          duration: durationMinutes, // 面试时长
        },
        resultId,
        startedAt: session.startTime, // 开始时间
        completedAt: new Date(), // 完成时间
      });

      this.logger.log(
        `✅ 面试结果保存成功（完整创建）: resultId=${resultId}, duration=${durationMinutes}min`,
      );

      return resultId; // 返回生成的结果ID
    } catch (error) {
      // 出现异常时记录错误并抛出
      this.logger.error(`❌ 保存面试结果失败: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 【步骤1】更新用户回答
   * 在用户提交回答时调用。该方法用于更新面试结果中的用户回答内容，并在用户首次回答时增加回答计数。
   * 另外，还可以同步更新面试会话的状态（sessionState），以便持续跟踪和保存面试进度。
   *
   * @param resultId - 面试结果的唯一标识符，用于查找对应的面试结果记录。
   * @param qaIndex - 问题的索引，用于确定更新的是哪一个问题的回答。
   * @param answer - 用户的回答内容。
   * @param answeredAt - 用户提交回答的时间。
   * @param session - 可选的 session 对象，用于更新面试会话的状态。
   *
   * @returns Promise<void> - 返回一个 `Promise`，表示更新操作的结果（没有返回值）。
   */
  private async updateInterviewAnswer(
    resultId: string,
    qaIndex: number,
    answer: string,
    answeredAt: Date,
    session?: InterviewSession, // 可选的 session，用于更新 sessionState
  ): Promise<void> {
    try {
      // 检查是否是第一次回答（避免重复增加计数）
      // 查找面试结果，检查该问题是否已经有回答
      const existingRecord = await this.aiInterviewResultModel.findOne({
        resultId,
      });

      // 判断是否是第一次回答
      const isFirstAnswer =
        !existingRecord?.qaList[qaIndex]?.answer ||
        existingRecord.qaList[qaIndex].answer === '';

      // 更新操作的查询对象
      const updateQuery: any = {
        $set: {
          [`qaList.${qaIndex}.answer`]: answer, // 更新当前问题的回答内容
          [`qaList.${qaIndex}.answeredAt`]: answeredAt, // 更新回答时间
        },
      };

      // 如果传递了 session（即存在面试会话），同步更新会话状态
      if (session) {
        updateQuery.$set.sessionState = session;
      }

      // 只有在第一次回答时，才增加已回答问题的计数
      if (isFirstAnswer) {
        updateQuery.$inc = { answeredQuestions: 1 }; // 增加回答的数量
      }

      // 更新面试结果记录，并返回更新后的记录
      const result = await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId },
        updateQuery,
        { new: true }, // 获取更新后的记录
      );

      if (result) {
        // 更新成功，记录日志
        this.logger.log(
          `✅ [步骤1] 更新用户回答成功: resultId=${resultId}, qaIndex=${qaIndex}, answer前50字=${answer.substring(0, 50)}..., isFirstAnswer=${isFirstAnswer}`,
        );
      } else {
        // 更新失败，记录错误日志
        this.logger.error(
          `❌ [步骤1] 更新用户回答失败: 未找到 resultId=${resultId}`,
        );
      }
    } catch (error) {
      // 处理异常并记录错误
      this.logger.error(
        `❌ [步骤1] 更新用户回答异常: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * 【步骤2】创建问题占位项
   * 在AI开始生成问题前调用。该方法用于在面试结果中创建一个“问题占位项”，
   * 以便在AI生成问题之前，能够先占据一个位置，保证面试流程的顺利进行。
   * 这个占位项会在实际问题生成后更新为问题内容和答案。
   *
   * @param resultId - 面试结果的唯一标识符，用于查找对应的面试结果记录。
   * @param askedAt - 问题生成的时间，通常是AI开始生成问题的时间。
   *
   * @returns Promise<void> - 返回一个 `Promise`，表示创建占位项的操作结果（没有返回值）。
   */
  private async createInterviewQuestionPlaceholder(
    resultId: string,
    askedAt: Date,
  ): Promise<void> {
    try {
      // 创建问题占位项，表示问题正在生成中
      const placeholderItem = {
        question: '[生成中...]', // 占位文本，表示问题正在生成
        answer: '', // 用户回答为空
        standardAnswer: '', // 标准答案为空
        answerDuration: 0, // 答案时长为空
        askedAt: askedAt, // 问题生成的时间
        answeredAt: null, // 答案时间为空，尚未回答
      };

      // 使用 findOneAndUpdate 更新面试记录，将占位项添加到 qaList 数组中
      const result = await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId }, // 查找对应的面试结果记录
        {
          $push: { qaList: placeholderItem }, // 将占位项添加到 qaList
          $inc: { totalQuestions: 1 }, // 更新总问题数
        },
        { new: true }, // 返回更新后的记录
      );

      if (result) {
        // 更新成功，记录日志
        this.logger.log(
          `✅ [步骤2] 创建问题占位项成功: resultId=${resultId}, qaList长度=${result.qaList.length}`,
        );
      } else {
        // 更新失败，记录错误日志
        this.logger.error(
          `❌ [步骤2] 创建问题占位项失败: 未找到 resultId=${resultId}`,
        );
      }
    } catch (error) {
      // 处理异常并记录错误
      this.logger.error(
        `❌ [步骤2] 创建问题占位项异常: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * 【步骤3】更新问题内容
   * 在AI问题生成完成后调用。该方法用于更新面试记录中的问题内容，
   * 以便将AI生成的实际问题填充到相应的位置，从而更新占位符为具体的面试问题。
   *
   * @param resultId - 面试结果的唯一标识符，用于查找对应的面试结果记录。
   * @param qaIndex - 问题的索引，用于确定更新的是哪一个问题。
   * @param question - AI生成的实际问题内容。
   * @param askedAt - 问题生成的时间，通常是AI生成问题的时间。
   *
   * @returns Promise<void> - 返回一个 `Promise`，表示更新操作的结果（没有返回值）。
   */
  private async updateInterviewQuestion(
    resultId: string,
    qaIndex: number,
    question: string,
    askedAt: Date,
  ): Promise<void> {
    try {
      // 更新面试记录中的问题内容
      const result = await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId }, // 查找对应的面试记录
        {
          $set: {
            [`qaList.${qaIndex}.question`]: question, // 更新问题内容
            [`qaList.${qaIndex}.askedAt`]: askedAt, // 更新问题生成时间
          },
        },
        { new: true }, // 返回更新后的记录
      );

      if (result) {
        // 更新成功，记录日志
        this.logger.log(
          `✅ [步骤3] 更新问题内容成功: resultId=${resultId}, qaIndex=${qaIndex}, question前50字=${question.substring(0, 50)}...`,
        );
      } else {
        // 更新失败，记录错误日志
        this.logger.error(
          `❌ [步骤3] 更新问题内容失败: 未找到 resultId=${resultId}`,
        );
      }
    } catch (error) {
      // 处理异常并记录错误
      this.logger.error(
        `❌ [步骤3] 更新问题内容异常: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * 【步骤4】更新标准答案
   * 在AI标准答案生成完成后调用。该方法用于更新面试记录中的标准答案，
   * 以便将AI生成的标准答案填充到相应的问题记录中，从而确保面试问题的完整性。
   *
   * @param resultId - 面试结果的唯一标识符，用于查找对应的面试记录。
   * @param qaIndex - 问题的索引，用于确定更新的是哪一个问题的标准答案。
   * @param standardAnswer - AI生成的标准答案内容。
   *
   * @returns Promise<void> - 返回一个 `Promise`，表示更新操作的结果（没有返回值）。
   */
  private async updateInterviewStandardAnswer(
    resultId: string,
    qaIndex: number,
    standardAnswer: string,
  ): Promise<void> {
    try {
      // 更新面试记录中的标准答案
      const result = await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId }, // 查找对应的面试记录
        {
          $set: {
            [`qaList.${qaIndex}.standardAnswer`]: standardAnswer, // 更新标准答案
          },
        },
        { new: true }, // 返回更新后的记录
      );

      if (result) {
        // 更新成功，记录日志
        this.logger.log(
          `✅ [步骤4] 更新标准答案成功: resultId=${resultId}, qaIndex=${qaIndex}, standardAnswer前50字=${standardAnswer.substring(0, 50)}...`,
        );
      } else {
        // 更新失败，记录错误日志
        this.logger.error(
          `❌ [步骤4] 更新标准答案失败: 未找到 resultId=${resultId}`,
        );
      }
    } catch (error) {
      // 处理异常并记录错误
      this.logger.error(
        `❌ [步骤4] 更新标准答案异常: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * 结束面试（用户主动结束）
   * 使用 resultId（持久化）查询
   */
  async endMockInterview(userId: string, resultId: string): Promise<void> {
    // 1. 从数据库查询面试记录
    const dbResult = await this.aiInterviewResultModel.findOne({
      resultId,
      userId,
    });

    if (!dbResult) {
      throw new NotFoundException('面试记录不存在');
    }

    if (dbResult.status === 'completed') {
      throw new BadRequestException('面试已经结束');
    }

    // 2. 从 sessionState 获取会话
    let session: InterviewSession;

    if (dbResult.sessionState) {
      session = dbResult.sessionState as InterviewSession;
    } else {
      throw new NotFoundException('无法加载面试状态');
    }

    // 3. 标记为已结束
    session.isActive = false;

    // 4. 添加面试结束语
    const closingStatement = this.aiService.generateClosingStatement(
      session.interviewerName,
      session.candidateName,
    );

    session.conversationHistory.push({
      role: 'interviewer',
      content: closingStatement,
      timestamp: new Date(),
    });

    // 5. 保存结果
    await this.saveMockInterviewResult(session);

    // TODO：6. 异步生成评估报告（不阻塞返回）

    // 7. 从内存中清理会话（如果存在）
    if (session.sessionId) {
      this.interviewSessions.delete(session.sessionId);
      this.logger.log(`🗑️ 会话已从内存清理: sessionId=${session.sessionId}`);
    }
  }

  /**
   * 暂停面试
   * 使用 resultId（持久化）查询
   */
  async pauseMockInterview(
    userId: string,
    resultId: string,
  ): Promise<{ resultId: string; pausedAt: Date }> {
    let pausedAt: Date;
    try {
      // 1. 从数据库查询面试记录
      const dbResult = await this.aiInterviewResultModel.findOne({
        resultId,
        userId,
      });

      if (!dbResult) {
        throw new NotFoundException('面试记录不存在');
      }

      if (dbResult.status === 'paused') {
        throw new BadRequestException('面试已经暂停');
      }

      if (dbResult.status === 'completed') {
        throw new BadRequestException('面试已经结束，无法暂停');
      }

      // 2. 更新记录为暂停状态
      pausedAt = new Date();
      await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId },
        {
          $set: {
            status: 'paused',
            pausedAt,
          },
        },
      );

      this.logger.log(`⏸️ 面试已暂停: resultId=${resultId}`);

      // 3. 从内存中清理会话（如果存在）
      const session = dbResult.sessionState as InterviewSession;
      if (session?.sessionId) {
        this.interviewSessions.delete(session.sessionId);
        this.logger.log(`🗑️ 会话已从内存清理: sessionId=${session.sessionId}`);
      }
    } catch (error) {
      this.logger.error(`❌ 暂停面试异常: ${error.message}`, error.stack);
      throw error;
    }
    return {
      resultId,
      pausedAt,
    };
  }

  /**
   * 恢复面试
   * 使用 resultId（持久化）查询
   */
  async resumeMockInterview(
    userId: string,
    resultId: string,
  ): Promise<{
    resultId: string;
    sessionId: string;
    currentQuestion: number;
    totalQuestions?: number;
    lastQuestion?: string;
    conversationHistory: Array<{
      role: 'interviewer' | 'candidate';
      content: string;
      timestamp: Date;
    }>;
  }> {
    try {
      // 1. 从数据库查询面试记录
      const dbResult = await this.aiInterviewResultModel.findOne({
        resultId,
        userId,
        status: 'paused',
      });

      if (!dbResult) {
        throw new NotFoundException('未找到可恢复的面试，或面试未暂停');
      }

      // 2. 从 sessionState 恢复会话
      if (!dbResult.sessionState) {
        throw new BadRequestException('会话数据不完整，无法恢复');
      }

      const session: InterviewSession =
        dbResult.sessionState as InterviewSession;

      // 确保会话数据完整
      if (!session || !session.sessionId) {
        throw new BadRequestException('会话数据不完整，无法恢复');
      }

      // 3. 重新激活会话并放回内存
      session.isActive = true;
      this.interviewSessions.set(session.sessionId, session);

      // 4. 更新数据库状态
      await this.aiInterviewResultModel.findOneAndUpdate(
        { resultId },
        {
          $set: {
            status: 'in_progress',
            resumedAt: new Date(),
            sessionState: session, // 更新会话状态
          },
        },
      );

      this.logger.log(
        `▶️ 面试已恢复: resultId=${resultId}, sessionId=${session.sessionId}, questionCount=${session.questionCount}`,
      );

      // 5. 获取最后一个问题
      let lastQuestion: string | undefined;
      if (session.conversationHistory.length > 0) {
        const lastEntry =
          session.conversationHistory[session.conversationHistory.length - 1];
        if (lastEntry.role === 'interviewer') {
          lastQuestion = lastEntry.content;
        }
      }

      return {
        resultId,
        sessionId: session.sessionId,
        currentQuestion: session.questionCount,
        lastQuestion,
        conversationHistory: session.conversationHistory,
      };
    } catch (error) {
      this.logger.error(`❌ 恢复面试异常: ${error.message}`, error.stack);
      throw error;
    }
  }
}
