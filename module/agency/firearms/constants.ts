/** Setting keys (registered as gurps.agency-ammo-*). */
export const SETTING_TRACKING = 'ammo-tracking'
export const SETTING_EMPTY = 'ammo-empty'
export const SETTING_THROWN = 'ammo-thrown'

/** Localization root. */
export const L10N = 'GURPS.agency.firearms'

/** Flag path for per-actor state: flags.gurps.agency.firearms.weapons.<id>. */
export const FLAG_PATH = 'flags.gurps.agency.firearms.weapons'

/** Partial magazines (ejected with rounds left): flags.gurps.agency.firearms.partials. */
export const PARTIALS_PATH = 'flags.gurps.agency.firearms.partials'

/** Marker the pre-roll hook leaves on optionalArgs for the roll-complete hook. */
export const FIRE_MARK = 'agencyFirearms'

export const RELOAD_CONFIG_TEMPLATE = 'systems/gurps/templates/agency/firearms-config.hbs'
export const CHANGE_MAGAZINE_TEMPLATE = 'systems/gurps/templates/agency/firearms-magazines.hbs'
