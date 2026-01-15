import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { QrCodeStatus, QrCodeState } from './dto/wechat.dto';
import { Logger } from '@nestjs/common';
import { buildTextReply } from './utils/wechat';
import { User, UserDocument } from '../user/schemas/user.schema';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);
  private qrCodeStore = new Map<string, QrCodeState>();

  /**
   * 微信公众号 / 微信开放平台相关配置
   * 实际生产环境中应通过环境变量注入，避免敏感信息硬编码
   */
  private readonly wechatConfig = {
    /**
     * 微信 AppID
     * 用于标识当前公众号 / 应用的唯一身份
     * 在获取 access_token、创建二维码等接口中必需
     */
    appId: process.env.WECHAT_APP_ID || 'your_app_id',

    /**
     * 微信 AppSecret
     * 与 AppID 配对使用的密钥
     * 用于服务端换取 access_token，必须严格保密
     */
    appSecret: process.env.WECHAT_APP_SECRET || 'your_app_secret',

    /**
     * 微信授权回调地址
     * 用于 OAuth 授权流程，在用户同意授权后跳转回业务系统
     * 需要在微信公众平台后台进行白名单配置
     */
    redirectUri:
      process.env.WECHAT_REDIRECT_URI ||
      'https://lgdsunday.club/wechat/callback',

    /**
     * 服务器配置中的 Token
     * 用于微信服务器与业务服务器之间的签名校验
     * 主要应用于消息推送与服务器验证场景
     */
    token: process.env.WECHAT_TOKEN || 'your_token',

    /**
     * 消息加解密密钥 EncodingAESKey
     * 用于对微信推送的消息进行 AES 加解密
     * 在开启“安全模式”或“兼容模式”时必须配置
     */
    encodingAESKey:
      process.env.WECHAT_ENCODING_AES_KEY || 'your_encoding_aes_key',
  };

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 生成用于微信扫码登录的二维码
   * @returns 二维码地址、二维码唯一 ID、过期时间
   */
  async generateLoginQrCode(): Promise<{
    qrCodeUrl: string;
    qrCodeId: string;
    expireTime: number;
  }> {
    // 生成二维码唯一标识
    // 使用时间戳 + 随机字符串，避免并发场景下 ID 冲突
    const qrCodeId = `qr_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 计算二维码过期时间（5 分钟后）
    // 该时间用于服务端校验二维码是否失效
    const expireTime = Date.now() + 5 * 60 * 1000;

    /**
     * 第一步：获取微信 access_token
     * access_token 是调用微信开放 API 的全局凭证
     */
    const tokenRes = await axios.get(
      'https://api.weixin.qq.com/cgi-bin/token',
      {
        params: {
          grant_type: 'client_credential',
          appid: this.wechatConfig.appId,
          secret: this.wechatConfig.appSecret,
        },
      },
    );

    // 从响应中读取 access_token
    const accessToken = tokenRes.data.access_token;

    // access_token 获取失败时，直接中断流程并抛出错误
    if (!accessToken) {
      throw new Error(
        `获取 access_token 失败: ${JSON.stringify(tokenRes.data)}`,
      );
    }

    /**
     * 第二步：创建临时二维码
     * 使用字符串场景值（scene_str）绑定二维码与登录状态
     */
    const createRes = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${accessToken}`,
      {
        // 二维码有效期，单位：秒
        expire_seconds: 300,
        action_name: 'QR_STR_SCENE',
        action_info: {
          scene: {
            // scene_str 用于在扫码回调时识别是哪一个二维码
            scene_str: qrCodeId,
          },
        },
      },
    );

    // 校验二维码 ticket 是否生成成功
    if (!createRes.data.ticket) {
      throw new Error(`生成二维码失败: ${JSON.stringify(createRes.data)}`);
    }

    // 微信返回的二维码票据
    const ticket = createRes.data.ticket;

    // 根据 ticket 拼接最终可访问的二维码图片地址
    const qrCodeUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(
      ticket,
    )}`;

    /**
     * 第三步：在服务端缓存二维码状态
     * 用于后续扫码回调、轮询登录状态等流程
     */
    this.qrCodeStore.set(qrCodeId, {
      id: qrCodeId,
      openid: '', // 用户扫码后会写入对应的 openid
      status: QrCodeStatus.PENDING, // 初始状态：未扫码
      expireTime, // 过期时间
      createdAt: Date.now(), // 创建时间
    });

    // 返回前端所需的二维码信息
    return {
      qrCodeUrl,
      qrCodeId,
      expireTime,
    };
  }

  /**
   * 判断用户是否已经关注公众号
   */
  async markQrCodeScanned(wxParsed: any, openid: string): Promise<boolean> {
    try {
      // 检查 EventKey 是否存在
      if (!wxParsed.EventKey) {
        this.logger.warn('EventKey 为空，不是登录二维码');
        return false;
      }

      // 对于首次关注事件，eventKey 会是 'qrscene_xxx'
      const qrCodeId = wxParsed.EventKey.startsWith('qrscene_')
        ? wxParsed.EventKey.replace('qrscene_', '')
        : wxParsed.EventKey;

      const record = this.qrCodeStore.get(qrCodeId);
      if (!record) {
        // 不是登录二维码，返回 false
        this.logger.log(`二维码 ${qrCodeId} 不在登录队列中`);
        return false;
      }

      if (record.expireTime < Date.now()) {
        record.status = QrCodeStatus.EXPIRED;
        this.logger.warn(`二维码 ${qrCodeId} 已过期`);
      } else {
        record.username = wxParsed.ToUserName;
        record.status = QrCodeStatus.CONFIRMED;
        record.openid = openid;
        this.logger.log(`二维码 ${qrCodeId} 扫码成功, openid: ${openid}`);
      }

      this.qrCodeStore.set(qrCodeId, record);
      return true;
    } catch (error) {
      this.logger.error('markQrCodeScanned 处理失败:', error);
      return false;
    }
  }

  /**
   * 处理用户关注事件，返回欢迎消息
   */
  async handleSubscribe(wxParsed: any): Promise<string> {
    const welcomeMessage =
      '👋 您好，欢迎来到汪汪职道！我们为您提供专业的求职服务： 📝 简历优化 → 📚 笔试押题 → 📊 行测训练 → 💬 模拟面试 → 💰 薪资谈判 从简历到offer，全程护航您的求职之路！✨';

    return buildTextReply(wxParsed, welcomeMessage);
  }

  /**
   * 检查二维码状态
   */
  async getQrCodeStatus(qrCodeId: string): Promise<{
    status: QrCodeStatus;
    user?: any;
    token?: string;
  }> {
    const qrCodeState = this.qrCodeStore.get(qrCodeId);

    if (!qrCodeState) {
      return { status: QrCodeStatus.EXPIRED };
    }

    // 检查是否过期
    if (Date.now() > qrCodeState.expireTime) {
      this.qrCodeStore.delete(qrCodeId);
      return { status: QrCodeStatus.EXPIRED };
    }

    if (qrCodeState.status === QrCodeStatus.CONFIRMED && qrCodeState.openid) {
      // 获取用户信息并生成token
      const user = await this.findOrCreateWechatUser(qrCodeState.openid);
      const token = await this.generateJwt(user);

      // 清理二维码状态
      this.qrCodeStore.delete(qrCodeId);

      return {
        status: QrCodeStatus.CONFIRMED,
        user,
        token,
      };
    }

    return { status: qrCodeState.status };
  }

  /**
   * 查找或创建微信用户
   */
  async findOrCreateWechatUser(openid: string): Promise<User> {
    let user = await this.userModel.findOne({ openid }).exec();

    if (!user) {
      // 创建新用户
      const userData: Partial<User> = {
        openid,
        username: `旺旺-${Math.random().toString(36).slice(2, 8)}`, // 生成一个随机的名字
        phone: '', // 微信用户可能没有手机号
        isWechatBound: true,
        wechatBoundTime: new Date(),
        // 赠送 20 旺旺币
        wwCoinBalance: 20,
      };
      this.logger.log('创建新用户，赠送 20 旺旺币', userData);
      user = await this.userModel.create(userData);
    } else {
      // 修改 isWechatBound 为 true
      await user.updateOne({ isWechatBound: true });
    }

    return user;
  }

  /**
   * 生成JWT token
   * Token过期时间：下一个凌晨4点（48-72小时之间）
   */
  async generateJwt(user: User): Promise<string> {
    const id = (user as any)._id || (user as any).id;

    const token = this.jwtService.sign({
      sub: id,
      openid: user.openid,
      username: user.username,
      phone: user.phone,
    });

    // 记录token过期时间
    this.logger.log(`生成JWT Token: userId=${id}}`);

    return token;
  }
}
