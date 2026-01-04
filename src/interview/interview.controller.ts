import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  BadRequestException,
  Res,
  Sse,
  Param,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InterviewService } from './services/interview.service';
import { ResumeQuizDto } from './dto/resume-quiz.dto';
import {
  AnswerMockInterviewDto,
  StartMockInterviewDto,
} from './dto/mock-interview.dto';
import { ResponseUtil } from '../common/utils/response.util';

@Controller('interview')
export class InterviewController {
  constructor(private readonly interviewService: InterviewService) {}

  /**
   * 8.3-LangChain 实战-分析报告
   * @param body
   * @returns
   */
  @Post('/analyze-resume')
  @UseGuards(JwtAuthGuard)
  async analyzeResume(
    @Body() body: { position: string; resume: string; jobDescription: string },
    @Request() req: any,
  ) {
    const result = await this.interviewService.analyzeResume(
      req.user.userId,
      body.position,
      body.resume,
      body.jobDescription,
    );

    return {
      code: 200,
      data: result,
    };
  }

  /**
   * 8.4-对话历史和上下文管理
   * @param body
   * @returns
   */
  @Post('/continue-conversation')
  async continueConversation(
    @Body() body: { sessionId: string; question: string },
  ) {
    const result = await this.interviewService.continueConversation(
      body.sessionId,
      body.question,
    );

    return {
      code: 200,
      data: {
        response: result,
      },
    };
  }

  /**
   * 简历押题的接口
   */
  @Post('resume/quiz/stream')
  @UseGuards(JwtAuthGuard)
  async resumeQuizStream(
    @Body() dto: ResumeQuizDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    // 订阅进度事件
    const subscription = this.interviewService
      .generateResumeQuizWithProgress(userId, dto)
      .subscribe({
        next: (event) => {
          // 发送 SSE 事件
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        error: (error) => {
          // 发送错误事件
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: error.message,
            })}\n\n`,
          );
          res.end();
        },
        complete: () => {
          // 完成后关闭连接
          res.end();
        },
      });

    // 客户端断开连接时取消订阅
    req.on('close', () => {
      subscription.unsubscribe();
    });
  }

  /**
   * 开始模拟面试 - SSE流式响应
   */
  @Post('mock/start')
  @UseGuards(JwtAuthGuard)
  async startMockInterview(
    @Body() dto: StartMockInterviewDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;

    // 设置 SSE 响应头
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    res.setHeader('Access-Control-Allow-Origin', '*'); // 如果需要CORS

    // 发送初始注释，保持连接活跃
    res.write(': connected\n\n');
    // flush 数据（如果可用）
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }

    // 订阅进度事件
    const subscription = this.interviewService
      .startMockInterviewWithStream(userId, dto)
      .subscribe({
        next: (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          // flush 数据（如果可用）
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        },
        error: (error) => {
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: error.message,
            })}\n\n`,
          );
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
          res.end();
        },
        complete: () => {
          res.end();
        },
      });

    // 客户端断开连接时取消订阅
    req.on('close', () => {
      subscription.unsubscribe();
    });
  }

  /**
   * 回答面试问题 - SSE流式响应
   */
  @Post('mock/answer')
  @UseGuards(JwtAuthGuard)
  async answerMockInterview(
    @Body() dto: AnswerMockInterviewDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;

    // 设置 SSE 响应头
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    res.setHeader('Access-Control-Allow-Origin', '*'); // 如果需要CORS

    // 发送初始注释，保持连接活跃
    res.write(': connected\n\n');
    // flush 数据（如果可用）
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }

    // 订阅进度事件
    const subscription = this.interviewService
      .answerMockInterviewWithStream(userId, dto.sessionId, dto.answer)
      .subscribe({
        next: (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          // flush 数据（如果可用）
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        },
        error: (error) => {
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: error.message,
            })}\n\n`,
          );
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
          res.end();
        },
        complete: () => {
          res.end();
        },
      });

    // 客户端断开连接时取消订阅
    req.on('close', () => {
      subscription.unsubscribe();
    });
  }

  /**
   * 结束面试（用户主动结束）
   */
  @Post('mock/end/:resultId')
  @UseGuards(JwtAuthGuard)
  async endMockInterview(
    @Param('resultId') resultId: string,
    @Request() req: any,
  ) {
    await this.interviewService.endMockInterview(req.user.userId, resultId);

    return ResponseUtil.success({ resultId }, '面试已结束，正在生成分析报告');
  }

  /**
   * 暂停面试
   */
  @Post('mock/pause/:resultId')
  @UseGuards(JwtAuthGuard)
  async pauseMockInterview(
    @Param('resultId') resultId: string,
    @Request() req: any,
  ) {
    const result = await this.interviewService.pauseMockInterview(
      req.user.userId,
      resultId,
    );

    return ResponseUtil.success(result, '面试已暂停，进度已保存');
  }

  /**
   * 恢复面试
   */
  @Post('mock/resume/:resultId')
  @UseGuards(JwtAuthGuard)
  async resumeMockInterview(
    @Param('resultId') resultId: string,
    @Request() req: any,
  ) {
    const result = await this.interviewService.resumeMockInterview(
      req.user.userId,
      resultId,
    );

    return ResponseUtil.success(result, '面试已恢复，可以继续回答');
  }
}
