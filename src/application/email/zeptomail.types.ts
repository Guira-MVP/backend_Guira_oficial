export interface ZeptoMailAddress {
  address: string;
  name?: string;
}

export interface ZeptoMailRecipient {
  email_address: ZeptoMailAddress;
}

export interface ZeptoMailInlineImage {
  content: string;
  mime_type: string;
  cid: string;
}

export interface ZeptoMailSendRequest {
  from: ZeptoMailAddress;
  to: ZeptoMailRecipient[];
  cc?: ZeptoMailRecipient[];
  bcc?: ZeptoMailRecipient[];
  reply_to?: ZeptoMailAddress[];
  subject: string;
  htmlbody?: string;
  textbody?: string;
  track_clicks?: boolean;
  track_opens?: boolean;
  client_reference?: string;
  inline_images?: ZeptoMailInlineImage[];
}

export interface ZeptoMailSuccessResponse {
  data: unknown[];
  message: string;
  request_id: string;
}

export interface ZeptoMailErrorDetail {
  code: string;
  message: string;
  target?: string;
}

export interface ZeptoMailErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ZeptoMailErrorDetail[];
    request_id: string;
  };
}
