"""The terminal is attached to exactly one program. This is what it holds."""

from app.attachment import (
    Attachment, FRONT_DOOR, JOSHUA, GAME, NORAD_OPS, prompt_for,
)


def test_front_door_and_joshua_show_the_films_bare_prompt():
    # The film shows no mode indicator in either, so brackets appear only
    # where the film shows nothing.
    assert prompt_for(Attachment(mode=FRONT_DOOR)) == ">"
    assert prompt_for(Attachment(mode=JOSHUA)) == ">"


def test_a_game_names_itself_in_the_prompt():
    att = Attachment(mode=GAME, program="tictactoe")
    assert prompt_for(att, abbrev="TTT") == "[TTT]>"


def test_a_game_with_no_abbrev_falls_back_to_its_id():
    att = Attachment(mode=GAME, program="gtw")
    assert prompt_for(att) == "[GTW]>"


def test_norad_operations_names_itself():
    assert prompt_for(Attachment(mode=NORAD_OPS)) == "[NORAD]>"


def test_an_attachment_remembers_where_to_return():
    # Detaching from a game returns to whatever attached it — Joshua for a
    # home terminal, NORAD operations for an operator.
    att = Attachment(mode=GAME, program="gtw", parent=NORAD_OPS)
    assert att.parent == NORAD_OPS
