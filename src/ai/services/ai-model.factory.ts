import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatDeepSeek } from '@langchain/deepseek';

/**
 * AI 模型工厂服务
 *
 * 这个服务负责初始化和管理 AI 模型
 * 所有的模型初始化逻辑都集中在这里
 *
 * 好处：
 * - 集中管理：所有模型都配置在一处，方便统一修改和维护
 * - 易于切换：以后要换模型（比如从 DeepSeek 换成其他模型），只需要修改这里
 * - 易于复用：任何服务都可以使用这个工厂来获取模型
 * - 易于测试：可以单独测试模型初始化逻辑
 *
 * 如何在其他服务中使用？
 *
 * @Injectable()
 * export class QuizService {
 *  constructor(private aiModelFactory: AIModelFactory) {}
 *  async getCompletion(prompt: string) {
 *    const model = this.aiModelFactory.createDefaultModel();
 *    // 使用 model
 *  }
 * }
 */
@Injectable()
export class AIModelFactory {
  private readonly logger = new Logger(AIModelFactory.name);

  constructor(private configService: ConfigService) {}

  /**
   * 创建默认的 AI 模型
   *
   * 这是最常用的模型初始化方法。
   * 返回一个配置好的 ChatDeepSeek 模型实例
   *
   * 参数都来自环境变量，这样可以根据部署环境灵活配置：
   * - DEEPSEEK_API_KEY： 密钥
   * - DEEPSEEK_MODEL：模型名称（deepseek-chat 或 deepseek-reasoner）
   * - DEEPSEEK_TEMPERATURE：温度参数（控制随机性）
   * - DEEPSEEK_MAX_TOKENS：最大令牌（TOKEN）数（控制生成文本的长度）
   */
  createDefaultModel(): ChatDeepSeek {
    const apiKey = this.configService.get<string>('DEEPSEEK_API_KEY');

    if (!apiKey) {
      this.logger.warn('DEEPSEEK_API_KEY is not provided');
    }

    // deepseek-reasoner：思考模式（慢，适合需要深度推理的任务，如数学、逻辑题）
    // deepseek-chat：非思考模式（快，适合内容生成任务，如面试问题、文案创作）
    // 对于生成面试问题，使用deepseek-chat更快（10-30秒），reasoner会超时（5-10分钟）
    return new ChatDeepSeek({
      apiKey: apiKey || 'dummy-key',
      model:
        this.configService.get<string>('DEEPSEEK_MODEL') || 'deepseek-chat',
      temperature:
        this.configService.get<number>('DEEPSEEK_TEMPERATURE') || 0.7,
      maxTokens: this.configService.get<number>('DEEPSEEK_MAX_TOKENS') || 4000,
    });
  }

  /**
   * 创建用于稳定输出的模型（评估场景）
   *
   * 有些场景需要 AI 的输出更稳定，更一致（比如评估答案、打分）
   * 这个方法创建一个 temperature 较低的模型。
   */
  createStableModel(): ChatDeepSeek {
    const baseModel = this.createDefaultModel();
    return new ChatDeepSeek({
      apiKey: this.configService.get<string>('DEEPSEEK_API_KEY') || 'dummy-key',
      model: baseModel.model,
      temperature: 0.3, // 更低的 temperature会使输出更确定
      maxTokens: 4000,
    });
  }

  /**
   * 创建用于创意输出的模型（如写诗、写故事）
   */
  createCreativeModel(): ChatDeepSeek {
    const baseModel = this.createDefaultModel();
    return new ChatDeepSeek({
      apiKey: this.configService.get<string>('DEEPSEEK_API_KEY') || 'dummy-key',
      model: baseModel.model,
      temperature: 0.8, //高的 temperature会使输出更随机
      maxTokens: 4000,
    });
  }
}
