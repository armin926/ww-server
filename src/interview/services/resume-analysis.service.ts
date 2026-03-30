import { Injectable, Logger } from '@nestjs/common';
import { AIModelFactory } from '../../ai/services/ai-model.factory';
import { PromptTemplate } from '@langchain/core/prompts';
import { RESUME_QUIZ_PROMPT } from '../../interview/prompt/resume-quiz.prompt';
import { JsonOutputParser } from '@langchain/core/output_parsers';

/**
 * 简历分析结果接口
 */
export interface ResumeAnalysisResult {
  years_of_experience: number;
  skills: string[];
  recent_position: string;
  education: string;
  match_score: number;
  strengths: string[];
  gaps: string[];
  summary: string;
}

/**
 * 简历分析服务
 *
 * 这个服务负责分析简历的 AI Chain
 * - 管理简历分析的 prompt
 * - 初始化分析 Chain
 * - 调用 AI 进行分析
 *
 * 为什么要单独提取这个服务？
 * 因为简历分析涉及特定的Prompt和Chain，将来可能还有其他分析（编程题分析、答题分析等）
 * 每个分析都有自己的Prompt和Chain，所以我们为每个分析创建一个独立的服务。
 */
@Injectable()
export class ResumeAnalysisService {
  private readonly logger = new Logger(ResumeAnalysisService.name);

  constructor(private aiModelFactory: AIModelFactory) {}

  /**
   * 简历分析
   * @param resumeContent 简历内容
   * @param jobDescription 职位描述
   * @returns 分析结果（JSON格式）
   */
  async analyze(
    resumeContent: string,
    jobDescription: string,
  ): Promise<ResumeAnalysisResult> {
    // 第一步创建Prompt模板
    const prompt = PromptTemplate.fromTemplate(RESUME_QUIZ_PROMPT);
    // 第二步获取模型
    const model = this.aiModelFactory.createDefaultModel();
    // 第三步创建输出解析器
    const parser = new JsonOutputParser();
    // 第四步组建链（Chain）
    const chain = prompt.pipe(model).pipe(parser);

    try {
      this.logger.log('开始分析简历');
      // 第五步调用链（Chain）进行分析
      const result = await chain.invoke({
        resumeText: resumeContent,
        job_description: jobDescription,
      });
      this.logger.log('简历分析完成');
      return result as ResumeAnalysisResult;
    } catch (error) {
      this.logger.error('简历分析失败', error);
      throw error;
    }
  }
}
