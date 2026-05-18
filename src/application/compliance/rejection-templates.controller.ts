import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { RejectionTemplatesService } from './rejection-templates.service';
import {
  CreateRejectionTemplateDto,
  UpdateRejectionTemplateDto,
} from './dto/rejection-templates.dto';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

/**
 * Endpoints for staff to list quick-comment templates.
 * Any authenticated staff member can read active templates.
 */
@ApiTags('Rejection Templates')
@ApiBearerAuth()
@Controller('admin/rejection-templates')
@UseGuards(RolesGuard)
export class RejectionTemplatesController {
  constructor(private readonly service: RejectionTemplatesService) {}

  /**
   * GET /admin/rejection-templates?category=in_review
   * Lists active templates, optionally filtered by category.
   * Available to staff, admin, super_admin.
   */
  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'List active rejection templates' })
  @ApiQuery({ name: 'category', required: false })
  async list(@Query('category') category?: string) {
    return this.service.list(category);
  }

  /**
   * GET /admin/rejection-templates/all?category=in_review
   * Lists ALL templates (including inactive) for admin management.
   */
  @Get('all')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'List all templates (including inactive) for admin management',
  })
  @ApiQuery({ name: 'category', required: false })
  async listAll(@Query('category') category?: string) {
    return this.service.listAll(category);
  }

  /**
   * POST /admin/rejection-templates
   * Creates a new template. Admin/super_admin only.
   */
  @Post()
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Create a new rejection template' })
  async create(@Body() dto: CreateRejectionTemplateDto, @Req() req: any) {
    const actorId = req.user?.id ?? req.user?.sub;
    return this.service.create(dto, actorId);
  }

  /**
   * PATCH /admin/rejection-templates/:id
   * Updates a template (label, body, is_active, sort_order). Admin/super_admin only.
   */
  @Patch(':id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Update a rejection template' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRejectionTemplateDto,
  ) {
    return this.service.update(id, dto);
  }

  /**
   * DELETE /admin/rejection-templates/:id
   * Soft-deletes a template (sets is_active = false). Admin/super_admin only.
   */
  @Delete(':id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Soft-delete a rejection template' })
  async remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
