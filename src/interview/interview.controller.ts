import {
  Controller,
  Post,
  UseGuards,
  Body,
  Request,
  Res,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InterviewService } from './services/interview.service';
import { ResumeQuizDto } from './dto/resume-quiz.dto';
import type { Response, Request as ExpressRequest } from 'express';
import {
  AnswerMockInterviewDto,
  StartMockInterviewDto,
} from './dto/mock-interview.dto';
import { ResponseUtil } from 'src/common/utils/response.util';

// 扩展 Response 接口以包含 flush 方法
interface ResponseWithFlush extends Response {
  flush?: () => void;
}

interface RequestWithUser extends ExpressRequest {
  user: {
    userId: string;
    username: string;
    email: string;
  };
}

@Controller('interview')
export class InterviewController {
  constructor(private readonly interviewService: InterviewService) {}
  @Post('/analyze-resume')
  @ApiTags('简历分析')
  @UseGuards(JwtAuthGuard)
  async analyzeResume(
    @Body() body: { position: string; resume: string; jobDescription: string },
    @Request() req: RequestWithUser,
  ) {
    const res = await this.interviewService.analyzeResume(
      req.user.userId,
      body.position,
      body.resume,
      body.jobDescription,
    );
    return {
      code: 200,
      data: res,
    };
  }
  @Post('/continue-conversation')
  @ApiTags('继续对话')
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
  // 接口 1：简历押题
  @Post('resume/quiz/stream')
  @UseGuards(JwtAuthGuard)
  resumeQuizStream(
    @Body() dto: ResumeQuizDto,
    @Request() req: RequestWithUser,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    // 订阅进度事件
    const subscription = this.interviewService
      .generateResumeQuizWithProgress(userId, dto)
      .subscribe({
        next: (event) => {
          // 发送SSE事件
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        error: (error: Error) => {
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

  // 接口 2：开始模拟面试
  @Post('mock/start')
  @UseGuards(JwtAuthGuard)
  startMockInterview(
    @Body() dto: StartMockInterviewDto,
    @Request() req: RequestWithUser,
    @Res() res: ResponseWithFlush,
  ) {
    const userId = req.user.userId;
    // 设置 SSE 响应头
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    res.setHeader('Access-Control-Allow-Origin', '*'); // 如果需要COS

    // 发送初始注释，保持连接状态
    res.write(':connected\n\n');
    // flush数据（如果可用）
    if (typeof res.flush === 'function') {
      res.flush();
    }
    // 订阅进度事件
    const subscription = this.interviewService
      .startMockInterviewStream(userId, dto)
      .subscribe({
        next: (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          // flush数据（如果可用）
          if (typeof res.flush === 'function') {
            res.flush();
          }
        },
        error: (error: Error) => {
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: error.message,
            })}\n\n`,
          );
          if (typeof res.flush === 'function') {
            res.flush();
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

  // 接口 3：回答面试问题
  @Post('mock/answer')
  @UseGuards(JwtAuthGuard)
  async answerMockInterview(
    @Body() dto: AnswerMockInterviewDto,
    @Request() req: RequestWithUser,
    @Res() res: ResponseWithFlush,
  ) {
    const userId = req.user.userId;
    // 设置 SSE 响应头
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    res.setHeader('Access-Control-Allow-Origin', '*'); // 如果需要COS

    res.write(':connected\n\n');
    if (typeof res.flush === 'function') {
      res.flush();
    }
    // 订阅进度事件
    const subscription = await this.interviewService
      .answerMockInterviewWithStream(userId, dto.sessionId, dto.answer)
      .subscribe({
        next: (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (typeof res.flush === 'function') {
            res.flush();
          }
        },
        error: (error: Error) => {
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: error.message,
            })}\n\n`,
          );
          if (typeof res.flush === 'function') {
            res.flush();
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

  // 接口 4：结束面试
  @Post('mock/end/:resultId')
  @UseGuards(JwtAuthGuard)
  async endMockInterview(
    @Param('resultId') resultId: string,
    @Request() req: RequestWithUser,
  ) {
    await this.interviewService.endMockInterview(req.user.userId, resultId);
    return ResponseUtil.success({ resultId }, '面试已结束，正在生成分析报告');
  }
  // 暂停面试
  @Post('mock/pause/:resultId')
  @UseGuards(JwtAuthGuard)
  async pauseMockInterview(
    @Param('resultId') resultId: string,
    @Request() req: RequestWithUser,
  ) {
    await this.interviewService.pauseMockInterview(req.user.userId, resultId);
    return ResponseUtil.success({ resultId }, '面试已暂停，进度已保存');
  }
  // 恢复面试
  @Post('mock/resume/:resultId')
  @UseGuards(JwtAuthGuard)
  async resumeMockInterview(
    @Param('resultId') resultId: string,
    @Request() req: RequestWithUser,
  ) {
    await this.interviewService.resumeMockInterview(req.user.userId, resultId);
    return ResponseUtil.success({ resultId }, '面试已恢复，可以继续回答');
  }
}
