import { Injectable, Logger } from '@nestjs/common';
import { AIModelFactory } from '../../ai/services/ai-model.factory';
import { Message } from '../../ai/interface/message.interface';
import { PromptTemplate } from '@langchain/core/prompts';
import { CONVERSATION_CONTINUATION_PROMPT } from '../prompt/resume-quiz.prompt';

@Injectable()
export class ConversationContinuationService {
  private readonly logger = new Logger(ConversationContinuationService.name);

  constructor(private aiModelFactory: AIModelFactory) {}

  async continue(history: Message[]): Promise<string> {
    // 第一步：创建Prompt 模板
    const prompt = PromptTemplate.fromTemplate(
      CONVERSATION_CONTINUATION_PROMPT,
    );
    // 第二步：获取模型
    const model = this.aiModelFactory.createDefaultModel();
    // 第三步：组建链
    const chain = prompt.pipe(model);

    try {
      this.logger.log(`继续对话，历史消息数：${history.length}`);
      // 第四步：调用链
      const res = await chain.invoke({
        history: history.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
      });
      // 第五步：获取回答内容
      const aiResponse = res.content as string;
      this.logger.log('对话继续完成');
      return aiResponse;
    } catch (error) {
      this.logger.error('对话继续失败', error);
      throw error;
    }
  }
}
