declare module 'errio' {
  export function parse(error: Error): Error;
  export function stringify(error: Error): string;
  export function register(error: ErrorConstructor): void;
}
declare module '@tiddlygit/tiddlywiki' {
  export interface I$TW {
    boot: { argv: string[]; startup: (options: { callback: () => unknown }) => void };
  }
  export function TiddlyWiki(): I$TW;
}

declare module 'threads-plugin' {
  const value: any;
  export default value;
}
declare module 'webpack2-externals-plugin' {
  const value: any;
  export default value;
}
declare module '*.png' {
  const value: string;
  export default value;
}
declare module '*.svg' {
  const value: string;
  export default value;
}
declare module '@authing/sso' {
  export interface ILoginInfo {
    urlParams: UrlParameters;
    userInfo: UserInfo;
  }
  export interface ITrackSessionResultSuccess extends ILoginInfo {
    session: Session;
  }
  export interface ITrackSessionResultFailed {
    session: null;
  }
  export type ITrackSessionResult = ITrackSessionResultSuccess | ITrackSessionResultFailed;

  export interface Session {
    appId: string;
    type: string;
    userId: string;
  }

  export interface UserInfo {
    _id: string;
    company: string;
    email: string;
    nickname: string;
    oauth?: string;
    photo: string;
    registerInClient: string;
    thirdPartyIdentity?: {
      accessToken?: string;
      provider?: string;
    };
    token: string;
    tokenExpiredAt: string;
    username: string;
  }

  export interface UrlParameters {
    access_token: string;
    code: string;
    id_token: string;
  }

  export default class AuthingSSO {
    constructor(options: { appDomain: string; appId: string; redirectUrl: string });
    trackSession(): Promise<ITrackSessionResult>;
    logout(): Promise<{ code: number; message?: string }>;
    login(): Promise<void>;
  }
}
