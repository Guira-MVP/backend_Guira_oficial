import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/auth-response.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';
import { Public } from '../../core/guards/supabase-auth.guard';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RateLimitGuard } from '../../core/guards/rate-limit.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─────────────────────────────────────────────────────────────
  // Login (Hallazgo 4: login con rate limiting + logging backend)
  // ─────────────────────────────────────────────────────────────

  @Post('login')
  @Public()
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar sesión',
    description:
      'Autentica al usuario con email y contraseña. Aplica rate limiting y registra eventos de autenticación.',
  })
  @ApiResponse({ status: 200, description: 'Sesión iniciada exitosamente' })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  @ApiResponse({ status: 429, description: 'Demasiados intentos' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.login(dto, context);
  }

  // ─────────────────────────────────────────────────────────────
  // Register
  // ─────────────────────────────────────────────────────────────

  @Post('register')
  @Public()
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar nuevo usuario',
    description:
      'Crea un usuario en Supabase Auth. El trigger de DB creará el perfil automáticamente con role=client y onboarding_status=pending.',
  })
  @ApiResponse({ status: 201, description: 'Usuario creado exitosamente' })
  @ApiResponse({ status: 409, description: 'Email ya registrado' })
  @ApiResponse({ status: 429, description: 'Demasiados intentos' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.register(dto, context);
  }

  // ─────────────────────────────────────────────────────────────
  // Get Me
  // ─────────────────────────────────────────────────────────────

  @Get('me')
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({
    summary: 'Obtener datos del usuario autenticado',
    description:
      'Retorna el perfil completo incluyendo rol, estado de onboarding y límites de transacción.',
  })
  @ApiResponse({ status: 200, description: 'Perfil del usuario' })
  @ApiResponse({ status: 401, description: 'Token inválido o expirado' })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getMe(user.id);
  }

  // ─────────────────────────────────────────────────────────────
  // Refresh Token
  // ─────────────────────────────────────────────────────────────

  @Post('refresh')
  @Public()
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renovar token de acceso',
    description: 'Usa un refresh token para obtener un nuevo access token.',
  })
  @ApiResponse({ status: 200, description: 'Token renovado' })
  @ApiResponse({ status: 401, description: 'Refresh token inválido' })
  @ApiResponse({ status: 429, description: 'Demasiados intentos' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.refreshToken(dto.refresh_token, context);
  }

  // ─────────────────────────────────────────────────────────────
  // Logout
  // ─────────────────────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({
    summary: 'Cerrar sesión',
    description: 'Invalida la sesión del usuario en Supabase Auth.',
  })
  @ApiResponse({ status: 200, description: 'Sesión cerrada' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.logout(user.id, context);
  }

  // ─────────────────────────────────────────────────────────────
  // Forgot Password
  // ─────────────────────────────────────────────────────────────

  @Post('forgot-password')
  @Public()
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Solicitar restablecimiento de contraseña',
    description:
      'Envía un correo con un enlace para restablecer la contraseña a la cuenta asociada.',
  })
  @ApiResponse({ status: 200, description: 'Correo enviado (si existe)' })
  @ApiResponse({ status: 429, description: 'Demasiados intentos' })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.forgotPassword(dto, context);
  }

  // ─────────────────────────────────────────────────────────────
  // Reset Password
  // ─────────────────────────────────────────────────────────────

  @Post('reset-password')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restablecer contraseña',
    description:
      'Actualiza la contraseña del usuario. Requiere estar autenticado con el token especial recibido por correo.',
  })
  @ApiResponse({ status: 200, description: 'Contraseña actualizada' })
  @ApiResponse({ status: 401, description: 'Token inválido o expirado' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.resetPassword(user.id, dto, context);
  }

  // ─────────────────────────────────────────────────────────────
  // OAuth Callback (Corrección G1: auditoría + G3: perfil)
  // ─────────────────────────────────────────────────────────────

  @Post('oauth-callback')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Notificar login OAuth',
    description:
      'Llamado desde el frontend tras exchangeCodeForSession. Registra el evento de login OAuth en la tabla de auditoría y asegura que el perfil tenga full_name.',
  })
  @ApiResponse({ status: 200, description: 'Callback procesado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  async oauthCallback(
    @Body() dto: OAuthCallbackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const context = this.authService.extractRequestContext(req);
    return this.authService.oauthCallback(user.id, dto.provider, context);
  }
}
