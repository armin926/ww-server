import { Controller } from '@nestjs/common';
import { Post, Header, Req, Get, Query } from '@nestjs/common';
import type { Request } from 'express';
import { WechatService } from './wechat.service';
import { ResponseUtil } from '../common/utils/response.util';
import { Logger } from '@nestjs/common';
import { QrCodeStatus } from './dto/wechat.dto';

import * as xml2js from 'xml2js';

@Controller('wechat')
export class WechatController {
  private readonly logger = new Logger(WechatController.name);

  constructor(private readonly wechatService: WechatService) {}

  /**
   * 生成登录二维码
   */
  @Post('qrcode')
  async generateQrCode() {
    try {
      const result = await this.wechatService.generateLoginQrCode();
      return ResponseUtil.success(result, '二维码生成成功');
    } catch (error) {
      this.logger.error('生成二维码失败:', error);
      return ResponseUtil.error('生成二维码失败', 500, error.message);
    }
  }

  /**
 * 接收微信服务器推送的消息
 * 1. 被动回复用户消息（文本消息）
    https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Passive_user_reply_message.html
    说明：文本消息回复格式、XML 结构、CDATA 使用。
    2. 接收普通消息
    https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
    说明：消息接收与解析。
    3. 接收事件推送
    https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_event_pushes.html
    说明：关注/取消关注等事件处理。
    4. 开发文档首页
    https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html
    说明：开发概览与快速开始。
  */
  @Post('validateToken')
  @Header('Content-Type', 'text/xml;charset=UTF-8')
  async receiveWechatMessage(@Req() req: Request): Promise<string> {
    try {
      // 获取原始 XML 数据
      const buffers: any[] = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const rawXml = Buffer.concat(buffers).toString('utf-8');

      // 用 xml2js 解析 XML
      const parser = new xml2js.Parser({ explicitArray: false });
      const parsed = await parser.parseStringPromise(rawXml);
      const msgType = parsed?.xml?.MsgType;
      const eventKey = parsed?.xml?.EventKey;
      const event = parsed?.xml?.Event;
      const openid = parsed?.xml?.FromUserName;

      this.logger.log(
        `收到微信事件: event=${event}, eventKey=${eventKey}, openid=${openid}`,
      );

      if (event === 'subscribe') {
        // 用户关注事件
        const isLoginQrCode = await this.wechatService.markQrCodeScanned(
          parsed.xml,
          openid,
        );
        // 无论是否是登录二维码，都发送欢迎消息
        const welcomeReply = await this.wechatService.handleSubscribe(
          parsed.xml,
        );
        return welcomeReply;
      } else if (event === 'SCAN') {
        // 用户已关注，扫描二维码（登录场景）
        // 异步处理，不阻塞响应
        this.wechatService
          .markQrCodeScanned(parsed.xml, openid)
          .catch((err) => {
            this.logger.error('处理扫码事件失败:', err);
          });
        // 返回 success，表示已收到消息但不回复（微信要求必须返回有效响应）
        // return 'success';
        // 用户扫码登录，发送欢迎消息
        const welcomeReply = await this.wechatService.handleSubscribe(
          parsed.xml,
        );
        return welcomeReply;
      }
      // 用户的点击行为处理
      else if (msgType === 'event' && event === 'CLICK') {
        // 处理菜单点击事件
        const reply = await this.wechatService.handleTextMessage(parsed.xml);
        return reply;
      }

      return 'success';
    } catch (error) {
      this.logger.error('处理微信消息失败:', error);
      // 即使出错也要返回 success，避免微信重复推送
      return 'success';
    }
  }

  /**
   * 前端验证用户扫码状态
   */
  @Get('check-qr-status')
  async checkQrStatus(@Query('id') qrCodeId: string) {
    const { status, user, token } =
      await this.wechatService.getQrCodeStatus(qrCodeId);
    if (status === QrCodeStatus.EXPIRED) {
      return { code: 404, message: '二维码不存在或已过期' };
    }

    if (status === QrCodeStatus.CONFIRMED) {
      return {
        code: 200,
        message: '扫码成功',
        data: {
          user,
          token,
        },
      };
    }

    return {
      code: 202,
      message: '等待扫码',
    };
  }

  /**
   * 创建公众号自定义菜单
   */
  @Post('create-menu')
  async createMenu() {
    const result = await this.wechatService.createMenu();
    return ResponseUtil.success(result, '创建菜单成功');
  }

  // /**
  //  * 删除公众号自定义菜单
  //  */
  // @Post('delete-menu')
  // async deleteMenu() {
  //   const result = await this.wechatService.deleteMenu();
  //   return ResponseUtil.success(result, '删除菜单成功');
  // }

  // /**
  //  * 获取公众号自定义菜单
  //  */
  // @Get('get-menu')
  // async getMenu() {
  //   const result = await this.wechatService.getMenu();
  //   return ResponseUtil.success(result, '获取菜单成功');
  // }
}
