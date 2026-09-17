import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service';

/**
 * The Google Maps key as the browser needs it.
 *
 * Deliberately NOT on SettingsController: that whole controller is
 * `@Roles('admin')`, but everyone who opens the live map, the tracking screen,
 * a route or a customer's location picker needs this key, and almost none of
 * them are admins. Widening the settings controller to let them in would open
 * the JoFotara and ERP credentials to the same audience.
 *
 * So the write stays on the admin controller and the read lives here, with no
 * `@Roles` — which the guard treats as "any authenticated user". Anonymous
 * callers still get nothing.
 *
 * Returning the key in the clear is the point, not an oversight: Maps JS runs
 * in the browser and cannot use a key it never receives. What protects it is
 * the HTTP-referrer restriction on the key in Google Cloud.
 */
@ApiTags('settings')
@Controller({ path: 'maps-config', version: '1' })
export class MapsConfigController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Google Maps key for the browser',
    description:
      'The stored key if an admin set one, otherwise the server environment. ' +
      'Any signed-in user.',
  })
  @ApiOkResponse({ description: 'googleMapsApiKey + googleMapsMapId (empty when unset)' })
  get() {
    return this.settings.mapsRuntime();
  }
}
