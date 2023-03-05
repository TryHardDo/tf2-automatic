import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  ValidationPipe,
  HttpCode,
  Param,
  HttpStatus,
} from '@nestjs/common';
import {
  TF2Account,
  CraftResult,
  TF2_BASE_URL,
  TF2_ACCOUNT_PATH,
  TF2_CRAFT_PATH,
  TF2_USE_ITEM_PATH,
  TF2_ITEM_PATH,
  TF2_SORT_PATH,
  TF2ActionResult,
} from '@tf2-automatic/bot-data';
import { CraftDto } from './dto/craft.dto';
import { SortBackpackDto } from './dto/sort-backpack.dto';
import { TF2Service } from './tf2.service';

@Controller(TF2_BASE_URL)
export class TF2Controller {
  constructor(private readonly tf2Service: TF2Service) {}

  @Get(TF2_ACCOUNT_PATH)
  getAccount(): Promise<TF2Account> {
    return this.tf2Service.getAccount();
  }

  @Post(TF2_CRAFT_PATH)
  @HttpCode(HttpStatus.OK)
  craft(
    @Body(
      new ValidationPipe({
        transform: true,
      })
    )
    body: CraftDto
  ): Promise<CraftResult> {
    return this.tf2Service.craft(body);
  }

  @Post(TF2_USE_ITEM_PATH)
  @HttpCode(HttpStatus.OK)
  useItem(@Param('id') assetid: string): Promise<TF2ActionResult> {
    return this.tf2Service.useItem(assetid).then(() => {
      return {
        success: true,
      };
    });
  }

  @Delete(TF2_ITEM_PATH)
  deleteItem(@Param('id') assetid: string): Promise<TF2ActionResult> {
    return this.tf2Service.deleteItem(assetid).then(() => {
      return {
        success: true,
      };
    });
  }

  @Post(TF2_SORT_PATH)
  @HttpCode(HttpStatus.OK)
  sortBackpack(
    @Body(
      new ValidationPipe({
        transform: true,
      })
    )
    body: SortBackpackDto
  ): Promise<TF2ActionResult> {
    return this.tf2Service.sortBackpack(body).then(() => {
      return {
        success: true,
      };
    });
  }
}
