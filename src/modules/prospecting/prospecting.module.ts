import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { QuoteTemplate } from './entities/quote-template.entity';
import { Prospect } from './entities/prospect.entity';
import { ProspectSearch } from './entities/prospect-search.entity';
import { QuoteTemplatesController } from './quote-templates.controller';
import { QuoteTemplatesService } from './quote-templates.service';
import { ProspectsController } from './prospects.controller';
import { ProspectsService } from './prospects.service';
import { PlacesService } from './places.service';
import { WhatsappService } from './whatsapp.service';

/**
 * Prospecting (lead finder): quote templates + the public quote page (P1),
 * Google Places search with customer de-dup (P2), and the WhatsApp outreach
 * pipeline / convert-to-customer (P3).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([QuoteTemplate, Prospect, ProspectSearch, Customer]),
  ],
  controllers: [QuoteTemplatesController, ProspectsController],
  providers: [
    QuoteTemplatesService,
    ProspectsService,
    PlacesService,
    WhatsappService,
  ],
  exports: [QuoteTemplatesService, ProspectsService, WhatsappService],
})
export class ProspectingModule {}
