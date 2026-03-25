import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIModelFactory } from '../../ai/services/ai-model.factory';
import { RESUME_QUIZ_PROMPT } from '../prompt/resume-quiz.prompt';

@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  constructor(
    private configService: ConfigService,
    private aiModelFactory: AIModelFactory, // 注入 AI 模型工厂
  ) {}

  /**
   * 分析简历并生成报告
   * @param resumeContent 简历的文本内容
   * @param jobDescription 岗位要求
   * @returns 分析结果，包含工作年限、技能、匹配度等信息
   */
  async analyzeResume(resumeContent: string, jobDescription: string) {
    // 创建 prompt 模版
    const prompt = PromptTemplate.fromTemplate(RESUME_QUIZ_PROMPT);
    // 通过工厂获取模型（而不是自己初始化）
    const model = this.aiModelFactory.createDefaultModel();
    // 创建输出解析器
    const parser = new JsonOutputParser();
    // 创建链：Prompt -> 模型 -> 解析器
    // pipe是什么？ 管道，用于将一个函数的输出作为另一个函数的输入
    // 这里的意思是：prompt的输出（格式化后的Prompt）输入给model，model的输出（模型生成的文本）输入给parser，
    // parser的输出（解析后的对象）->最终得到解析结果
    const chain = prompt.pipe(model).pipe(parser);

    try {
      this.logger.log('开始分析简历');
      const result = await chain.invoke({
        resume_content: resumeContent,
        job_description: jobDescription,
      });
      this.logger.log('简历分析完成');
      return result;
    } catch (error) {
      this.logger.error('简历分析失败', error);
      throw error;
    }
  }
}
