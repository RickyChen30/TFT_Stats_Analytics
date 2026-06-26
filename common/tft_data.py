"""Static TFT reference data used for synthetic ingestion and entity naming.

These lists approximate a TFT set's champions, items, augments and traits. They
let the full pipeline run end-to-end without a live Riot API key (synthetic
mode) and give the dashboard human-readable entity ids.
"""
from __future__ import annotations

# (champion_id, cost, traits) — cost biases synthetic placement strength.
CHAMPIONS = [
    ("TFT_Ahri", 4, ["Spirit", "Sorcerer"]),
    ("TFT_Akali", 4, ["Assassin", "Ninja"]),
    ("TFT_Annie", 2, ["Sorcerer", "Demon"]),
    ("TFT_Aatrox", 5, ["Bruiser", "Demon"]),
    ("TFT_Ashe", 3, ["Ranger", "Glacial"]),
    ("TFT_Caitlyn", 5, ["Sniper", "Gunner"]),
    ("TFT_Darius", 1, ["Bruiser", "Imperial"]),
    ("TFT_Diana", 3, ["Assassin", "Moonlight"]),
    ("TFT_Ezreal", 2, ["Gunner", "Sorcerer"]),
    ("TFT_Fiora", 1, ["Duelist", "Imperial"]),
    ("TFT_Garen", 1, ["Knight", "Imperial"]),
    ("TFT_Graves", 2, ["Gunner", "Outlaw"]),
    ("TFT_Jhin", 4, ["Sniper", "Sorcerer"]),
    ("TFT_Jinx", 4, ["Gunner", "Rebel"]),
    ("TFT_Kaisa", 3, ["Assassin", "Voidborn"]),
    ("TFT_Karma", 3, ["Sorcerer", "Spirit"]),
    ("TFT_Katarina", 3, ["Assassin", "Imperial"]),
    ("TFT_Leona", 2, ["Knight", "Glacial"]),
    ("TFT_Lulu", 1, ["Sorcerer", "Yordle"]),
    ("TFT_Lux", 3, ["Sorcerer", "Glacial"]),
    ("TFT_MissFortune", 5, ["Gunner", "Outlaw"]),
    ("TFT_Nasus", 2, ["Bruiser", "Sentinel"]),
    ("TFT_Orianna", 4, ["Sorcerer", "Glacial"]),
    ("TFT_Senna", 1, ["Sniper", "Sentinel"]),
    ("TFT_Sett", 4, ["Bruiser", "Boxer"]),
    ("TFT_Syndra", 5, ["Sorcerer", "Spirit"]),
    ("TFT_Thresh", 2, ["Knight", "Sentinel"]),
    ("TFT_Twitch", 3, ["Sniper", "Rebel"]),
    ("TFT_Veigar", 4, ["Sorcerer", "Yordle"]),
    ("TFT_Yasuo", 5, ["Duelist", "Exile"]),
    ("TFT_Zed", 2, ["Assassin", "Ninja"]),
    ("TFT_Ziggs", 1, ["Sorcerer", "Yordle"]),
]

ITEMS = [
    "TFT_Item_InfinityEdge",
    "TFT_Item_GuinsoosRageblade",
    "TFT_Item_JeweledGauntlet",
    "TFT_Item_BlueBuff",
    "TFT_Item_SpearOfShojin",
    "TFT_Item_RabadonsDeathcap",
    "TFT_Item_GiantSlayer",
    "TFT_Item_RunaansHurricane",
    "TFT_Item_Bloodthirster",
    "TFT_Item_LastWhisper",
    "TFT_Item_Quicksilver",
    "TFT_Item_TitansResolve",
    "TFT_Item_WarmogsArmor",
    "TFT_Item_DragonsClaw",
    "TFT_Item_GargoyleStoneplate",
    "TFT_Item_SunfireCape",
    "TFT_Item_ThiefsGloves",
    "TFT_Item_HextechGunblade",
    "TFT_Item_Morellonomicon",
    "TFT_Item_IonicSpark",
]

AUGMENTS = [
    "TFT_Augment_PortableForge",
    "TFT_Augment_ItemGrabBag",
    "TFT_Augment_BuildARocket",
    "TFT_Augment_CyberneticImplants",
    "TFT_Augment_FuturePerfect",
    "TFT_Augment_TrueTwos",
    "TFT_Augment_RichGetRicher",
    "TFT_Augment_CalculatedLoss",
    "TFT_Augment_TomeOfTraits",
    "TFT_Augment_PandorasItems",
    "TFT_Augment_BinaryAirdrop",
    "TFT_Augment_LivingForge",  # known "trap" — looks good, plays mediocre
    "TFT_Augment_CelestialBlessing",
    "TFT_Augment_LudensEcho",
    "TFT_Augment_Hustler",
    "TFT_Augment_ThrillOfTheHunt",
]

# Named compositions (trait cores) for the composition entity type.
COMPOSITIONS = [
    "Sorcerers",
    "Assassins",
    "Gunners",
    "Snipers",
    "Bruisers",
    "Knights",
    "Glacial_Sorcerer",
    "Imperial_Bruiser",
    "Yordle_Sorcerer",
    "Rebel_Gunner",
    "Sentinel_Knight",
    "Ninja_Assassin",
]

TIERS = [
    "IRON",
    "BRONZE",
    "SILVER",
    "GOLD",
    "PLATINUM",
    "DIAMOND",
    "MASTER",
    "GRANDMASTER",
    "CHALLENGER",
]

# Rank ordering for priority queues (lower number = higher priority).
TIER_RANK = {t: i for i, t in enumerate(reversed(TIERS))}

REGIONS = ["NA", "EUW", "KR", "BR"]

# Riot routing: platform host per region, and the regional cluster for match-v1.
REGION_PLATFORM = {"NA": "na1", "EUW": "euw1", "KR": "kr", "BR": "br1"}
REGION_CLUSTER = {"NA": "americas", "EUW": "europe", "KR": "asia", "BR": "americas"}

CHAMPION_IDS = [c[0] for c in CHAMPIONS]
CHAMPION_COST = {c[0]: c[1] for c in CHAMPIONS}
CHAMPION_TRAITS = {c[0]: c[2] for c in CHAMPIONS}

DEFAULT_PATCH = "14.3"
