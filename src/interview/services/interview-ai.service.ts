import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import {
  RESUME_QUIZ_PROMPT_QUESTIONS_ONLY,
  RESUME_QUIZ_PROMPT_ANALYSIS_ONLY,
} from '../prompts/resume-quiz.prompts';
import {
  FORMAT_INSTRUCTIONS_QUESTIONS_ONLY,
  FORMAT_INSTRUCTIONS_ANALYSIS_ONLY,
} from '../prompts/format-instructions.prompts';
import { AIModelFactory } from '../../ai/services/ai-model.factory';
import { buildMockInterviewPrompt } from '../prompts/mock-interview.prompts';
/**
 * 简历押题输入
 */
export interface ResumeQuizInput {
  company: string;
  positionName: string;
  minSalary?: number;
  maxSalary?: number;
  jd: string;
  resumeContent: string;
  promptVersion?: string;
}

/**
 * 简历押题输出
 */
export interface ResumeQuizOutput {
  // 面试问题
  questions: Array<{
    question: string;
    answer: string;
    category: string;
    difficulty: string;
    tips: string;
    keywords?: string[];
    reasoning?: string;
  }>;

  // 综合评估
  summary: string;

  // 匹配度分析
  matchScore: number;
  matchLevel: string;

  // 技能分析
  matchedSkills: Array<{
    skill: string;
    matched: boolean;
    proficiency?: string;
  }>;
  missingSkills: string[];

  // 知识补充建议
  knowledgeGaps: string[];
  learningPriorities: Array<{
    topic: string;
    priority: 'high' | 'medium' | 'low';
    reason: string;
  }>;

  // 雷达图数据
  radarData: Array<{
    dimension: string;
    score: number;
    description?: string;
  }>;

  // 优势与劣势
  strengths: string[];
  weaknesses: string[];

  // 面试准备建议
  interviewTips: string[];

  // Token使用情况
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * 面试 AI 服务
 * 封装 LangChain + DeepSeek 的调用
 */
@Injectable()
export class InterviewAIService {
  private readonly logger = new Logger(InterviewAIService.name);

  constructor(
    private readonly configService: ConfigService,
    private aiModelFactory: AIModelFactory,
  ) {}

  /**
   * 生成简历押题 - 仅押题部分（问题 + 综合评估）
   * 返回：问题列表 + 综合评估 summary
   */
  async generateResumeQuizQuestionsOnly(
    input: ResumeQuizInput,
  ): Promise<{ questions: any[]; summary: string }> {
    const startTime = Date.now();

    try {
      // 1. 构建 Prompt
      // 使用之前在 9.2 中设计的 RESUME_QUIZ_PROMPT_QUESTIONS_ONLY
      const prompt = PromptTemplate.fromTemplate(
        RESUME_QUIZ_PROMPT_QUESTIONS_ONLY,
      );

      // 2. 创建输出解析器
      // JsonOutputParser 会自动解析 AI 返回的 JSON
      const parser = new JsonOutputParser();

      // 3. 构建链
      const model = this.aiModelFactory.createDefaultModel();
      const chain = prompt.pipe(model).pipe(parser);

      // 4. 准备参数
      const salaryRange =
        input.minSalary && input.maxSalary
          ? `${input.minSalary}K-${input.maxSalary}K`
          : input.minSalary
            ? `${input.minSalary}K起`
            : input.maxSalary
              ? `${input.maxSalary}K封顶`
              : '面议';

      const params = {
        company: input?.company || '',
        positionName: input.positionName,
        salaryRange: salaryRange,
        jd: input.jd,
        resumeContent: input.resumeContent,
        format_instructions: FORMAT_INSTRUCTIONS_QUESTIONS_ONLY,
      };

      this.logger.log(
        `🚀 [押题部分] 开始生成: company=${params.company}, position=${params.positionName}`,
      );

      // 5. 调用 AI
      const rawResult = await chain.invoke(params);
      this.logger.log(`🔍 [押题部分] 原始结果: ${rawResult}`);

      // 6. 验证结果
      // 虽然我们还没有 Zod 验证（下节课才加），但我们可以做基本检查
      if (!Array.isArray(rawResult.questions)) {
        throw new Error('AI返回的结果中 questions 不是数组');
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ [押题部分] 生成成功: 耗时=${duration}ms, 问题数=${rawResult.questions?.length || 0}`,
      );

      return rawResult as { questions: any[]; summary: string };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `❌ [押题部分] 生成失败: 耗时=${duration}ms, 错误=${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 生成简历押题 - 仅匹配度分析部分
   * 返回：匹配度、技能分析、学习建议、雷达图等
   */
  async generateResumeQuizAnalysisOnly(input: ResumeQuizInput): Promise<any> {
    const startTime = Date.now();

    try {
      // 流程与上面类似
      const prompt = PromptTemplate.fromTemplate(
        RESUME_QUIZ_PROMPT_ANALYSIS_ONLY,
      );

      const parser = new JsonOutputParser();

      const model = this.aiModelFactory.createDefaultModel();
      const chain = prompt.pipe(model).pipe(parser);

      const salaryRange =
        input.minSalary && input.maxSalary
          ? `${input.minSalary}K-${input.maxSalary}K`
          : input.minSalary
            ? `${input.minSalary}K起`
            : input.maxSalary
              ? `${input.maxSalary}K封顶`
              : '面议';

      const params = {
        company: input?.company || '',
        positionName: input.positionName,
        salaryRange: salaryRange,
        jd: input.jd,
        resumeContent: input.resumeContent,
        format_instructions: FORMAT_INSTRUCTIONS_ANALYSIS_ONLY,
      };

      this.logger.log(
        `🚀 [匹配度分析] 开始生成: company=${params.company}, position=${params.positionName}`,
      );

      const result = await chain.invoke(params);

      const duration = Date.now() - startTime;
      this.logger.log(`✅ [匹配度分析] 生成成功: 耗时=${duration}ms`);

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `❌ [匹配度分析] 生成失败: 耗时=${duration}ms, 错误=${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 生成模拟面试问题
   * 该方法根据输入的上下文信息动态生成面试问题，并以流的方式逐步返回内容。
   * 主要用于模拟面试的场景，提供一种流式的交互体验。
   *
   * @param context - 包含生成面试问题所需的上下文信息，包括面试类型、简历内容、公司信息、职位名称、职位描述、对话历史、已用时长和目标时长等。
   *   - interviewType: 'special' | 'comprehensive'，表示面试的类型，是专项面试还是综合面试。
   *   - resumeContent: string，表示候选人的简历内容。
   *   - company?: string，表示公司名称（可选）。
   *   - positionName?: string，表示职位名称（可选）。
   *   - jd?: string，表示职位描述（可选）。
   *   - conversationHistory: Array<{ role: 'interviewer' | 'candidate'; content: string }>，表示对话历史，包含角色（面试官或候选人）和发言内容。
   *   - elapsedMinutes: number，表示已经进行的面试时长（分钟）。
   *   - targetDuration: number，表示目标面试时长（分钟）。
   *
   * @returns AsyncGenerator<string> - 返回一个异步生成器，逐块返回流式生成的面试问题内容，直到面试问题生成完成。
   *
   * 该方法会进行以下步骤：
   * 1. 构建动态的 Prompt（生成问题的提示模板）。
   * 2. 创建 Prompt 模板并将其与 AI 模型连接。
   * 3. 使用流式方式生成面试问题，逐块返回给调用方。
   */
  async *generateInterviewQuestionStream(context: {
    interviewType: 'special' | 'comprehensive';
    resumeContent: string;
    company?: string;
    positionName?: string;
    jd?: string;
    conversationHistory: Array<{
      role: 'interviewer' | 'candidate';
      content: string;
    }>;
    elapsedMinutes: number;
    targetDuration: number;
  }): AsyncGenerator<string> {
    try {
      // 第 1 步：构建 Prompt（动态的）
      // 调用外部函数 buildMockInterviewPrompt，生成面试问题所需的提示内容
      const prompt = buildMockInterviewPrompt(context);

      // 第 2 步：创建 Prompt 模板
      // 使用 PromptTemplate.fromTemplate() 方法，将构建好的 prompt 转化为可执行的模板
      const promptTemplate = PromptTemplate.fromTemplate(prompt);

      // 第 3 步：构建链（Prompt → LLM）
      // 使用 AI 模型工厂创建一个默认的 AI 模型
      const model = this.aiModelFactory.createDefaultModel();
      // 将 prompt 模板和 AI 模型连接成一个管道（pipeline）
      const chain = promptTemplate.pipe(model);

      let fullContent = ''; // 用于存储生成的完整内容
      const startTime = Date.now(); // 记录流式生成开始的时间

      // 使用链条创建流式生成器进行异步生成
      const stream = await chain.stream({
        interviewType: context.interviewType, // 面试类型
        resumeContent: context.resumeContent, // 简历内容
        company: context.company || '', // 公司名称（若未提供为空）
        positionName: context.positionName || '未提供', // 职位名称（若未提供，使用默认值）
        jd: context.jd || '未提供', // 职位描述（若未提供，使用默认值）
        conversationHistory: this.formatConversationHistory(
          context.conversationHistory, // 格式化对话历史
        ),
        elapsedMinutes: context.elapsedMinutes, // 已用时长
        targetDuration: context.targetDuration, // 目标时长
      });

      // 逐块返回内容
      for await (const chunk of stream) {
        const content = chunk.content?.toString() || ''; // 获取每个块的内容
        if (content) {
          fullContent += content; // 将每个块的内容拼接到完整内容中
          yield content; // 立即返回当前块的内容给调用方
        }
      }

      // 计算流式生成所花费的时间并记录日志
      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ 流式生成完成: 耗时=${duration}ms, 长度=${fullContent.length}`,
      );

      // 返回最终生成的完整内容
      return this.parseInterviewResponse(fullContent, context);
    } catch (error) {
      // 错误处理：如果流式生成过程中出现任何异常，记录错误日志并抛出异常
      this.logger.error(
        `❌ 流式生成面试问题失败: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 格式化对话历史
   * 该方法将对话历史数组格式化为一段带有编号和角色标识的文本，
   * 其中每条记录都包含了发言者的角色（面试官或候选人）和内容。
   *
   * @param history - 包含对话历史的数组，每个元素有两个属性：
   *   - role: 'interviewer' | 'candidate'，表示发言者的角色，'interviewer' 表示面试官，'candidate' 表示候选人。
   *   - content: string，表示发言的内容。
   *
   * @returns string - 返回格式化后的字符串，每条记录由编号、角色和内容组成，
   *   如果历史为空或未传入，则返回一个提示信息（'（对话刚开始，这是候选人的自我介绍）'）。
   */
  private formatConversationHistory(
    history: Array<{ role: 'interviewer' | 'candidate'; content: string }>,
  ): string {
    // 如果历史为空或没有数据，返回默认的提示文本
    if (!history || history.length === 0) {
      return '（对话刚开始，这是候选人的自我介绍）';
    }

    // 遍历对话历史，生成格式化后的文本
    return (
      history
        .map((item, index) => {
          // 根据发言者的角色决定文本中的标识，'面试官' 或 '候选人'
          const role = item.role === 'interviewer' ? '面试官' : '候选人';
          // 返回格式化后的文本：编号 + 角色 + 内容
          return `${index + 1}. ${role}: ${item.content}`;
        })
        // 使用换行符连接每条记录，形成最终的多行字符串
        .join('\n\n')
    );
  }

  /**
   * 解析AI的面试回应
   * 该方法用于解析AI生成的面试回应内容。它从给定的面试回应中提取问题、标准答案以及是否应该结束面试的信息。
   * 主要处理以下内容：
   * - 是否包含结束标记，判断面试是否已经完成。
   * - 提取标准答案（如果存在）。
   * - 提取问题内容，并清理不需要的标记。
   *
   * @param content - AI生成的面试回应内容，包含问题、标准答案及可能的结束标记。
   * @param context - 面试上下文，包含已用时间（elapsedMinutes）和目标时长（targetDuration）。
   *
   * @returns 返回一个对象，包含以下信息：
   *   - question: 提取的面试问题内容。
   *   - shouldEnd: 布尔值，表示面试是否应该结束。
   *   - standardAnswer: 标准答案内容（如果有）。
   *   - reasoning: 如果面试已经结束，提供结束理由（基于目标时长）。
   */
  private parseInterviewResponse(
    content: string,
    context: {
      elapsedMinutes: number;
      targetDuration: number;
    },
  ): {
    question: string;
    shouldEnd: boolean;
    standardAnswer?: string;
    reasoning?: string;
  } {
    // 第 1 步：检查是否包含结束标记 [END_INTERVIEW]
    // 如果回应中包含 [END_INTERVIEW]，表示面试已经结束
    const shouldEnd = content.includes('[END_INTERVIEW]');

    // 第 2 步：提取标准答案
    let standardAnswer: string | undefined;
    let questionContent = content;

    // 使用正则表达式匹配标准答案部分，提取 [STANDARD_ANSWER] 到 [END_INTERVIEW] 或结束位置的内容
    const standardAnswerMatch = content.match(
      /\[STANDARD_ANSWER\]([\s\S]*?)(?=\[END_INTERVIEW\]|$)/,
    );

    // 如果匹配到了标准答案，提取并去除多余的空格
    if (standardAnswerMatch) {
      standardAnswer = standardAnswerMatch[1].trim();
      // 移除标准答案部分，只保留问题部分
      questionContent = content.split('[STANDARD_ANSWER]')[0].trim();
    }

    // 第 3 步：移除结束标记
    // 如果内容中有 [END_INTERVIEW]，去掉该标记，并进行清理
    questionContent = questionContent.replace(/\[END_INTERVIEW\]/g, '').trim();

    // 第 4 步：返回解析结果
    return {
      question: questionContent, // 提取的问题内容
      shouldEnd: shouldEnd, // 是否需要结束面试
      standardAnswer: standardAnswer, // 标准答案（如果存在）
      reasoning: shouldEnd
        ? `面试已达到目标时长（${context.elapsedMinutes}/${context.targetDuration}分钟）` // 如果结束，给出理由
        : undefined,
    };
  }

  /**
   * 生成面试开场白（非流式）
   * 该方法用于生成面试的开场白内容，根据面试官姓名、候选人姓名和职位名称动态生成问候语、职位信息和面试的开场提示。
   *
   * @param interviewerName - 面试官的姓名，用于问候候选人并提供称呼。
   * @param candidateName - 候选人的姓名（可选），如果提供，问候语中会使用候选人的名字；如果未提供，默认使用“你”。
   * @param positionName - 职位名称（可选），如果提供，开场白中会提到候选人申请的职位。
   *
   * @returns string - 返回生成的面试开场白内容，包含问候语、职位信息和自我介绍提示。
   */
  generateOpeningStatement(
    interviewerName: string,
    candidateName?: string,
    positionName?: string,
  ): string {
    // 第 1 步：生成问候语
    let greeting = candidateName ? `${candidateName}` : '你'; // 如果提供了候选人的名字，使用名字，否则使用“你”
    greeting += '好，我是你今天的面试官，你可以叫我'; // 构建问候语前半部分
    greeting += `${interviewerName}老师。\n\n`; // 添加面试官的名字，并以“老师”作为称呼

    // 第 2 步：如果提供了职位名称，添加职位相关信息
    if (positionName) {
      greeting += `我看到你申请的是${positionName}岗位。\n\n`; // 如果职位名称存在，提到候选人申请的岗位
    }

    // 第 3 步：生成面试的开始提示
    greeting +=
      '让我们开始今天的面试吧。\n\n' + // 提示面试开始
      '首先，请你简单介绍一下自己。自我介绍可以说明你的学历以及专业背景、工作经历以及取得的成绩等。'; // 提供自我介绍的指导

    // 第 4 步：返回生成的开场白内容
    return greeting;
  }

  /**
   * 流式生成面试开场白（模拟打字机效果）
   * 该方法使用流式生成的方式逐步返回面试开场白的内容，并模拟打字机效果。每次返回一小段字符，并通过延迟模拟打字的过程。
   *
   * @param interviewerName - 面试官的姓名，用于问候候选人并提供称呼。
   * @param candidateName - 候选人的姓名（可选），如果提供，问候语中会使用候选人的名字；如果未提供，默认使用“你”。
   * @param positionName - 职位名称（可选），如果提供，开场白中会提到候选人申请的职位。
   *
   * @returns AsyncGenerator<string, string, undefined> - 返回一个异步生成器，逐块返回流式的开场白内容片段。
   * 每次返回3-8个字符，模拟打字机的效果。
   */
  async *generateOpeningStatementStream(
    interviewerName: string,
    candidateName?: string,
    positionName?: string,
  ): AsyncGenerator<string, string, undefined> {
    // 第 1 步：生成完整的开场白
    // 调用 generateOpeningStatement 方法生成完整的面试开场白内容
    const fullGreeting = this.generateOpeningStatement(
      interviewerName,
      candidateName,
      positionName,
    );

    // 第 2 步：按字符分块，每次返回3-8个字符，模拟打字效果
    const chunkSize = 5; // 每次返回的字符块大小，模拟打字机效果的节奏
    for (let i = 0; i < fullGreeting.length; i += chunkSize) {
      // 截取从索引 i 到 i+chunkSize 的字符块
      const chunk = fullGreeting.slice(i, i + chunkSize);
      yield chunk; // 返回当前字符块

      // 第 3 步：添加小延迟，模拟真实打字（可选）
      await new Promise((resolve) => setTimeout(resolve, 20)); // 模拟每个字符的间隔时间
    }

    // 第 4 步：返回完整的开场白（即使已经通过流式返回了部分内容）
    return fullGreeting;
  }
}
