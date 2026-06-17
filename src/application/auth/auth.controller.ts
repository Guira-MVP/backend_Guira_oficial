import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
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
import { RefreshTokenDto } from './dto/auth-response.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';
import { Public } from '../../core/guards/supabase-auth.guard';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RateLimitGuard } from '../../core/guards/rate-limit.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

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
  @UseGuards(RateLimitGuard)
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

  // ─────────────────────────────────────────────────────────────
  // Sessions
  // ─────────────────────────────────────────────────────────────

  @Get('sessions')
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({
    summary: 'Listar sesiones activas',
    description: 'Retorna todas las sesiones activas del usuario autenticado.',
  })
  @ApiResponse({ status: 200, description: 'Lista de sesiones' })
  async listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const currentSessionId = this.authService.extractSessionId(req);
    return this.authService.listSessions(user.id, currentSessionId);
  }

  @Delete('sessions/others')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cerrar todas las otras sesiones',
    description: 'Revoca todas las sesiones activas excepto la sesión actual.',
  })
  @ApiResponse({ status: 200, description: 'Sesiones cerradas' })
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const currentSessionId = this.authService.extractSessionId(req);
    return this.authService.revokeOtherSessions(user.id, currentSessionId);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revocar una sesión específica',
    description: 'Cierra una sesión activa por su ID. Solo se pueden revocar sesiones propias.',
  })
  @ApiResponse({ status: 200, description: 'Sesión cerrada' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ) {
    return this.authService.revokeSession(user.id, sessionId);
  }

  // ─────────────────────────────────────────────────────────────
  // Admin: Desactivar MFA de un usuario (recuperación por teléfono perdido)
  // ─────────────────────────────────────────────────────────────

  @Delete('admin/users/:userId/mfa')
  @ApiBearerAuth('supabase-jwt')
  @UseGuards(RolesGuard)
  @Roles('staff', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desactivar MFA de un usuario (staff/admin)',
    description: 'Elimina todos los factores TOTP del usuario. Usar cuando el cliente pierde acceso a su autenticador.',
  })
  @ApiResponse({ status: 200, description: 'MFA desactivado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  async disableUserMfa(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') targetUserId: string,
  ) {
    return this.authService.disableUserMfa(actor.id, targetUserId);
  }
}
