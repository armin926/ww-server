import { v4 as uuidv4 } from 'uuid';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionManager } from '../../ai/services/session.manager';
import { ResumeAnalysisService } from './resume-analysis.service';
import { ConversationContinuationService } from './conversation-continuation.service';
import { RESUME_ANALYSIS_SYSTEM_MESSAGE } from '../prompt/resume-quiz.prompt';
import { ResumeQuizDto } from '../dto/resume-quiz.dto';
import { Subject } from 'rxjs';
import { InjectModel } from '@nestjs/mongoose';
import {
  ConsumptionRecord,
  ConsumptionStatus,
  ConsumptionType,
} from '../schemas/consumption-record.schema';
import { Model, Types } from 'mongoose';
import { ResumeQuizResult } from '../schemas/interview-quiz-reuslt.schema';
import { User } from '../../user/schemas/user.schema';
import { ConsumptionRecordDocument } from '../schemas/consumption-record.schema';
import { DocumentParserService } from './document-parser.service';
import { InterviewAIService } from './interview-ai.service';
import {
  MockInterviewEventDto,
  MockInterviewEventType,
  MockInterviewType,
  StartMockInterviewDto,
} from '../dto/mock-interview.dto';
import { dot } from 'node:test/reporters';
import {
  AIInterviewResult,
  AIInterviewResultDocument,
} from '../schemas/ai-interview-result.schema';

export interface ProgressEvent {
  type: 'progress' | 'error' | 'complete' | 'timeout';
  progress: number; // 0 - 100
  label?: string;
  message?: string;
  data?: any;
}

/**
 * AI 生成结果接口
 */
interface AIQuizResult {
  questions: Array<{
    question: string;
    answer: string;
    category: string;
    difficulty: string;
    tips: string;
    keywords?: string[];
    reasoning: string;
  }>;
  summary?: string;
  matchScore?: number;
  matchLevel?: string;
  matchedSkills?: Array<{
    skill: string;
    matched: boolean;
    proficiency?: string;
  }>;
  missingSkills?: string[];
  knowledgeGaps?: string[];
  learningPriorities?: Array<{
    topic: string;
    priority: string;
    reason: string;
  }>;
  radarData?: Array<{
    dimension: string;
    score: number;
    description?: string;
  }>;
  strengths?: string[];
  weaknesses?: string[];
  interviewTips?: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}
/**
 * 进度事件
 */
export interface ProgressEvent {
  type: 'progress' | 'error' | 'complete' | 'timeout';
  step?: number;
  label?: string;
  progress: number; // 0 - 100
  message?: string;
  data?: any;
  error?: string;
  stage?: 'prepare' | 'generating' | 'saving' | 'done'; // 当前阶段
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

@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);
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
    private consumptionRecordModel: Model<ConsumptionRecord>,
    @InjectModel(ResumeQuizResult.name)
    private resumeQuizResultModel: Model<ResumeQuizResult>,
    @InjectModel(User.name)
    private userModel: Model<User>,
    @InjectModel(AIInterviewResult.name)
    private aiInterviewResultModel: Model<AIInterviewResultDocument>,
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

    // 异步执行，通过 Subject 发送进度（不 await，让其在后台运行）
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
    let consumptionRecord: ConsumptionRecordDocument | null = null;
    const recordId = uuidv4();
    const resultId = uuidv4();

    try {
      // 步骤0：幂等性检查
      // ⚠️ 这是最关键的一步，防止重复生成
      if (dto.requestId) {
        // 在数据库中查询是否存在这个 requestid 的记录
        const existingRecord = await this.consumptionRecordModel.findOne({
          userId,
          'metadata.requestId': dto.requestId,
          status: {
            $in: [ConsumptionStatus.SUCCESS, ConsumptionStatus.PENDING],
          },
        });
        if (existingRecord) {
          // 找到了相同的 requestId 记录
          if (existingRecord.status === ConsumptionStatus.SUCCESS) {
            // 之前已经成功生成过，直接返回现有的结果
            this.logger.log(
              `重复请求，返回已有结果：requestId = ${dto.requestId}`,
            );
            // 查询之前生成的结果
            const existingResult = await this.resumeQuizResultModel.findOne({
              resultId: existingRecord.resultId,
            });
            if (!existingResult) {
              throw new BadRequestException('结果不存在');
            }
            // 直接返回，不再执行后续步骤，不再扣费
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
            throw new BadRequestException('请求正在处理中，请稍后查询');
          }
        }
      }
      // 步骤1：检查并扣除次数（原子操作）
      // ⚠️ 注意：扣费后如果后续步骤失败，会在catch块中自动退款
      const user = await this.userModel.findByIdAndUpdate(
        {
          _id: userId,
          resumeRemainingCount: { $gt: 0 }, // 条件：剩余次数大于0
        },
        {
          $inc: { resumeRemainingCount: -1 }, // 原子操作：余额 -1  $inc表示增量操作，意为减少1
        },
        { new: false }, // 返回更新前的文档，用于日志记录
      );
      // 检查扣费是否成功
      if (!user) {
        throw new BadRequestException('简历押题次数不足，请前往充值页面购买');
      }
      this.logger.log(
        `✅️ 扣费成功：userId=${userId},扣费前=${user.resumeRemainingCount}，扣费后=${user.resumeRemainingCount - 1}`,
      );

      // 步骤2：创建消费记录（pending）
      consumptionRecord = await this.consumptionRecordModel.create({
        recordId,
        user: new Types.ObjectId(userId),
        userId,
        type: ConsumptionType.RESUME_QUIZ, // 消费类型
        status: ConsumptionStatus.PENDING, // ⭐ 关键：标记为处理中
        consumedCount: 1, // 消费次数
        description: `简历押题 - ${dto.company || ''} ${dto.positionName}`,
        // 记录输入参数（用于调试和重现问题）
        inputData: {
          company: dto?.company || '',
          posistionName: dto.positionName,
          minSalary: dto.minSalary,
          maxSalary: dto.maxSalary,
          jd: dto.jd,
          resumeId: dto.resumeId,
        },
        resultId, // 结果ID
        // 元数据（包含幂等性检查的requestId）
        metadata: {
          requestId: dto.requestId, // 用于幂等性检查
          promptVersion: dto.promptVersion,
        },
        startedAt: new Date(), // 记录开始时间
      });
      this.logger.log(`✅️ 创建消费记录：recordId=${recordId}`);
      // 如果没有 requestId，或者 requestId 不存在，继续执行正常的生成流程
      // 阶段1：准备阶段
      this.emitProgress(
        progressSubject,
        0,
        '📚 正在读取简历文档...',
        'prepare',
      );
      this.logger.log(`开始提取简历内容：resumeId=${dto.resumeId}`);
      const resumeContent = await this.extractResumeContent(userId, dto);
      this.logger.log(`✅️ 简历内容提取成功：${resumeContent}`);
      this.logger.log(`✅️ 简历提取成功，长度${resumeContent.length}字符`);
      this.emitProgress(progressSubject, 5, '✅️ 简历解析完成', 'prepare');

      this.emitProgress(
        progressSubject,
        10,
        '🚀 准备就绪，即将开始 AI 生成...',
      );
      // 阶段2：AI生成阶段 - 分两步（10 - 90%）
      const aiStartTime = Date.now();
      this.logger.log(`🤖 开始生成押题部分...`);
      this.emitProgress(
        progressSubject,
        15,
        '🤖 AI正在理解您的简历内容并生成面试问题...',
      );
      this.getStagePrompt(progressSubject);
      // 第一步，生成押题部分
      const questionsResult =
        await this.aiService.generateResumeQuizQuestionsOnly({
          company: dto?.company || '',
          positionName: dto.positionName,
          minSalary: Number(dto.minSalary),
          maxSalary: Number(dto.maxSalary),
          jd: dto.jd,
          resumeContent,
        });
      this.logger.log(
        `✅️ 生成押题部分成功，耗时 ${Date.now() - aiStartTime} ms，问题数 ${questionsResult.questions.length}`,
      );
      this.emitProgress(
        progressSubject,
        50,
        '✅️ 面试问题生成完成，开始分析匹配度...',
      );
      // 第二步，生成匹配度分析
      this.logger.log(`🤖 开始生成匹配度分析...`);
      this.emitProgress(
        progressSubject,
        60,
        '🤖 AI正在分析您与岗位的匹配度...',
      );
      const analysisResult =
        await this.aiService.generateResumeQuizAnalysisOnly({
          company: dto?.company || '',
          positionName: dto.positionName,
          minSalary: Number(dto.minSalary),
          maxSalary: Number(dto.maxSalary),
          jd: dto.jd,
          resumeContent,
        });
      this.logger.log(`✅️ 匹配度分析完成`);
      const aiDuration = Date.now() - aiStartTime;
      this.logger.log(
        `⌚️ AI 总耗时：${aiDuration}ms ${(aiDuration / 1000).toFixed(1)}秒)`,
      );
      // 合并两部分结果
      const aiResult: AIQuizResult = {
        ...questionsResult,
        ...analysisResult,
      };
      // 阶段3：保存结果阶段
      await this.resumeQuizResultModel.create({
        resultId,
        user: new Types.ObjectId(userId),
        userId,
        company: dto.company || '',
        position: dto.positionName,
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
      this.logger.log(`✅️ 保存结果成功：resultId=${resultId}`);

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
        `✅️ 更新消费记录为成功状态：recordId=${consumptionRecord.recordId}`,
      );
      // 阶段4：返回结果
      const result = {
        resultId: resultId,
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
      this.emitComplete(progressSubject, result);
      this.emitProgress(
        progressSubject,
        100,
        `✅️ 所有分析完成，正在保存结果...响应数据为${JSON.stringify(result)}`,
      );
      return result;
    } catch (error: unknown) {
      // 错误处理
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `❌️ 简历押题生成失败：userId=${userId},error=${errorMessage}`,
        errorStack,
      );

      // 失败回滚流程
      try {
        // 1.返还次数（最重要！）
        this.logger.log(`🔙 开始退还次数：userId=${userId}`);
        await this.refundCount(userId, 'resume');
        this.logger.log(`✅️ 次数退还成功：userId=${userId}`);
        // 2.更新消费记录为失败
        if (consumptionRecord) {
          await this.consumptionRecordModel.findByIdAndUpdate(
            consumptionRecord._id,
            {
              $set: {
                status: ConsumptionStatus.FAILED, // 标记为失败
                errorMessage: errorMessage, // 记录错误信息
                errorStack:
                  process.env.NODE_ENV === 'development'
                    ? // 是否为开发环境，是则记录错误堆栈
                      errorStack
                    : undefined,
                failedAt: new Date(),
                isRefunded: true, // 标记为已退款
                refundedAt: new Date(),
              },
            },
          );
          this.logger.log(
            `✅️ 消费记录已更新为失败状态：recordId=${consumptionRecord.recordId}`,
          );
        }
      } catch (refundError: unknown) {
        // ⚠️ 退款失败是严重问题，需要人工介入！
        const refundErrorMessage =
          refundError instanceof Error
            ? refundError.message
            : String(refundError);
        const refundErrorStack =
          refundError instanceof Error ? refundError.stack : undefined;
        this.logger.error(
          `🚨 退款流程失败！这是严重问题，需要人工介入！` +
            `userId=${userId},` +
            `originalError=${errorMessage}, ` +
            `refundError=${refundErrorMessage}`,
          refundErrorStack,
        );
      }
      // 3.发送错误事件给前端
      if (progressSubject && !progressSubject.closed) {
        progressSubject.next({
          type: 'error',
          progress: 0,
          label: '❌️ 生成失败',
          error: errorMessage,
        });
        progressSubject.complete();
      }
      throw error;
    }
  }
  /**
   * 发送完成事件
   * @param subject
   * @param data
   */
  private emitComplete(
    subject: Subject<ProgressEvent> | undefined,
    data: unknown,
  ) {
    if (subject && !subject.closed) {
      subject.next({
        type: 'complete',
        progress: 100,
        label: '🎆 生成完成！',
        message: '生成完成',
        data,
      });
      subject.complete();
    }
  }
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
        // 原子操作：余额 +1  $inc表示增量操作，意为增加1
        $inc: { [field]: 1 },
      },
      { new: true }, // 返回更新后的文档
    );
    // 验证退款是否成功
    if (!result) {
      throw new Error(`退款失败：用户不存在 userId=${userId}`);
    }
    this.logger.log(
      `✅️ 次数退还成功： userId=${userId}, type=${type}, 退还后=${result[field]}`,
    );
  }
  /**
   * 不同阶段的提示信息
   * @param progressSubject
   */
  private getStagePrompt(
    progressSubject: Subject<ProgressEvent> | undefined,
  ): void {
    if (!progressSubject) return;
    // 定义不同阶段的提示信息
    const progressMessage = [
      //  0 - 20%：理解阶段
      { progress: 0.2, message: '图 AI 正在分析您的技术栈和项目经验..' },
      { progress: 0.25, message: '🔎 AI 正在识别您的核心竞争力...' },
      { progress: 0.3, message: '📚 AI 正在对比岗位要求与您的背景...' },
      // 20 - 50%: 设计问题阶段
      { progress: 0.35, message: '💡 AI 正在设计针对性的技术问题...' },
      { progress: 0.4, message: '📝 AI 正在挖掘您简历中的项目亮点...' },
      { progress: 0.45, message: '🧪 AI 正在构思场景化的面试问题...' },
      { progress: 0.5, message: '🔍 AI 正在设计不同难度的问题组合...' },
      { progress: 0.65, message: '🧠 AI正在分析您的技术深度和广度...' },
      { progress: 0.7, message: '📝 AI正在生成基于STAR法则的答案...' },
      // 50 - 70%: 优化阶段
      { progress: 0.75, message: '⭐ AI正在优化问题的表达方式...' },
      { progress: 0.8, message: '🎨 AI正在为您准备回答要点和技巧...' },
      { progress: 0.85, message: '💎 AI正在提炼您的项目成果和亮点...' },
      { progress: 0.9, message: '🔧 AI正在调整问题难度分布...' },
      // 70 - 90%: 完善阶段
      { progress: 0.95, message: '📚 AI正在补充技术关键词和考察点...' },
      { progress: 0.96, message: '👩‍🎓 AI 正在完善综合评估建议...' },
      { progress: 0.97, message: '🚀 AI正在做最后的质量检查...' },
      { progress: 0.98, message: '✅ AI即将完成问题生成...' },
    ];
    // 模拟一个定时器，每隔一秒，响应一次数据
    let progress = 0;
    let currentMessage = progressMessage[0];
    const interval = setInterval(
      () => {
        progress += 1;
        currentMessage = progressMessage[progress];
        this.emitProgress(
          progressSubject,
          progress,
          currentMessage.message,
          'generating',
        );
        // 简单处理，到了progressMessages 的 length 就停止
        if (progress === progressMessage.length - 1) {
          clearInterval(interval);
          this.emitProgress(
            progressSubject,
            100,
            '✅ AI 已完成问题生成',
            'done',
          );
          return {
            questions: [],
            analysis: [],
          };
        }
      },
      Math.floor(Math.random() * (2000 - 800 + 1)) + 800, // 每 0.8 - 2 秒更新一次
    );
  }
  /**
   * 发送进度事件
   * @param subject 进度 Subject
   * @param progress 进度百分比
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
        progress: Math.min(Math.max(progress, 0), 100), // 确保在 0 -100 范围内
        label,
        message: label,
        stage,
      });
    }
  }
  /**
   * 获取剩余次数
   * resume: 简历押题
   * special: 专项面试
   * behavior: HR+行测面试
   * @param userId
   * @param type
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
      case 'behavior':
        return user.behaviorRemainingCount;
      case 'special':
        return user.specialRemainingCount;
      default:
        return 0;
    }
  }
  /**
   * 提取简历内容
   * 支持三种方式：直接文本、结构化简历、上传文件
   * @param userId
   * @param dto
   */
  private async extractResumeContent(
    userId: string,
    dto: ResumeQuizDto,
  ): Promise<string> {
    // 优先级1：如果直接提供了简历文本，使用它
    if (dto.resumeContent) {
      this.logger.log(
        `✅️ 使用直接提供的简历文本，长度${dto.resumeContent.length}字符`,
      );
      return dto.resumeContent;
    }
    // 优先级2：如果提供了 resumeId，尝试查询
    if (dto.resumeURL) {
      try {
        // 1. 从 URL 下载文件
        const rawText = await this.documentParserService.parseDocumentFromUrl(
          dto.resumeURL,
        );
        // 2. 清理文本（移除格式化符号等）
        const cleanText = this.documentParserService.cleanText(rawText);
        // 3.验证内容质量
        const validation =
          this.documentParserService.validateResumeContent(cleanText);
        if (!validation.isValid) {
          throw new BadRequestException(validation.reason);
        }
        // 4.记录任何警告
        if (validation.warning && validation.warning.length > 0) {
          this.logger.warn(
            `⚠️ 简历内容可能存在问题：${validation.warning.join(', ')}`,
          );
        }
        // 5.检查内容长度（避免超长内容）
        const estimatedTokens =
          this.documentParserService.estimateTokens(cleanText);
        if (estimatedTokens > 6000) {
          this.logger.warn(
            `简历内容过长：${estimatedTokens} tokens，将进行截断`,
          );
          // 截取前 6000 tokens 对应的字符
          const maxChars = 6000 * 1.5; // 约9000字符
          const truncatedText = cleanText.substring(0, maxChars);

          this.logger.log(
            `简历已截断：原长度${cleanText.length}字符，截断后${truncatedText.length}字符，tokens≈${this.documentParserService.estimateTokens(truncatedText)}`,
          );
          return truncatedText;
        }
        this.logger.log(
          `✅️ 简历内容质量验证通过，长度${cleanText.length}字符,tokens≈${estimatedTokens}`,
        );
        return cleanText;
      } catch (error: unknown) {
        const err = error as { message?: string; stack?: string };
        // 文件解析失败，返回友好的错误信息
        if (error instanceof BadRequestException) {
          throw error;
        }
        this.logger.error(`DOCX文件解析失败：${err?.message}`);
      }
    }
    // 都没提供，返回错误
    throw new BadRequestException('请输入简历内容或提供简历URL');
  }
  /**
   * 开始模拟面试（流式响应）
   * @param userId 用户ID
   * @param dto 模拟面试参数
   * @returns Subject 流式事件
   */
  startMockInterviewStream(
    userId: string,
    dto: StartMockInterviewDto,
  ): Subject<MockInterviewEventDto> {
    const subject = new Subject<MockInterviewEventDto>();

    // 异步执行
    this.executeStartMockInterview(userId, dto, subject).catch(
      (error: unknown) => {
        const err = error as { message?: string; stack?: string };
        this.logger.error(`模拟面试启动失败: ${err.message}`, err.stack);
        if (subject && !subject.closed) {
          subject.next({
            type: MockInterviewEventType.ERROR,
            error: err.message,
          });
          subject.complete();
        }
      },
    );

    return subject;
  }
  /**
   * 处理候选人回答（流式响应）
   * @param userId 用户ID
   * @param sessionId 会话ID
   * @param answer 候选人回答
   * @returns Subject流式事件
   */
  answerMockInterviewWithStream(
    userId: string,
    sessionId: string,
    answer: string,
  ): Subject<MockInterviewEventDto> {
    const subject = new Subject<MockInterviewEventDto>();
    // 异步执行
    // this.executeAnswerMockInterview(userId, sessionId, answer, subject).catch(
    //   (error) => {
    //     const err = error as { message?: string; stack?: string };
    //     this.logger.error(`模拟面试启动失败: ${err.message}`, err.stack);
    //     if (subject && !subject.closed) {
    //       subject.next({
    //         type: MockInterviewEventType.ERROR,
    //         error: err.message,
    //       });
    //       subject.complete();
    //     }
    //   },
    // );
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
          $inc: { [countField]: -1 }, //扣除一次模拟面试的次数
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
        `✅️ 用户扣费成功：userId=${userId}, type=${dto.interviewType}, 扣费前=${user[countField]}, 扣费后=${user[countField] - 1}`,
      );
      // 2.提取简历内容
      // 提取用户简历内容（dto本身已包含resumeId和resumeContent）
      const resumeContent = await this.extractResumeContent(
        userId,
        dto as ResumeQuizDto,
      );
      // 3. 创建会话
      // 为每个面试生成唯一的会话ID
      const sessionId = uuidv4();
      const interviewerName = '面试官（张三老师）';
      // 设定面试的目标时长
      const targetDuration =
        dto.interviewType === MockInterviewType.SPECIAL
          ? this.SPECIAL_INTERVIEW_MAX_DURATION
          : this.BEHAVIOR_INTERVIEW_MAX_DURATION;
      // 根据工资范围生成工资区间
      const salaryRange =
        dto.minSalary && dto.maxSalary
          ? `${dto.minSalary}K - ${dto.maxSalary}K`
          : dto.minSalary
            ? `${dto.minSalary}K起`
            : dto.maxSalary
              ? `${dto.maxSalary}K封顶`
              : '';
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
      // 4.创建数据库并记录生成 resultId
      const resultId = uuidv4();
      const recordId = uuidv4();

      // 为会话分配 resultId 和消费记录id
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
      const countField: 'resume' | 'special' | 'behavior' =
        dto.interviewType === MockInterviewType.SPECIAL
          ? 'special'
          : 'behavior';
      await this.refundCount(userId, countField);
      throw error;
    }
  }
  /**
   * 结束面试（用户主动结束）
   * 使用 resultId （持久化） 查询
   */
  async endMockInterview(userId: string, resultId: string): Promise<void> {
    // TODO
  }
  /**
   * 暂停面试
   * 使用 resultId （持久化） 查询
   */
  async pauseMockInterview(
    userId: string,
    resultId: string,
  ): Promise<{ resultId: string; pausedAt: Date }> {
    // TODO
    return {
      resultId,
      pausedAt: new Date(),
    };
  }
  /**
   * 恢复面试
   * 使用 resultId （持久化） 查询
   */
  async resumeMockInterview(
    userId: string,
    resultId: string,
  ): Promise<{
    resultId: string;
    sessionId: string;
    currentQuestion: number;
    totalQuestions: number;
    lastQuestion?: string;
    conversationHistory: Array<{
      role: 'interviewer' | 'candidate';
      content: string;
      timestamp: Date;
    }>;
  }> {
    // TODO
    return {
      resultId,
      sessionId: '',
      currentQuestion: 0,
      totalQuestions: 0,
      lastQuestion: '',
      conversationHistory: [],
    };
  }
}
