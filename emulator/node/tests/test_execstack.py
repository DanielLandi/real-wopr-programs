from app.execstack import Frame, decode, encode


def test_round_trips_a_single_frame():
    frames = [Frame("school-mon", "PHASE MENU\nACCT 20,10")]
    assert decode(encode(frames), "school-mon") == frames


def test_round_trips_a_nested_stack():
    frames = [Frame("school-mon", "PHASE EXEC"), Frame("school", "STEP MENU")]
    assert decode(encode(frames), "school-mon") == frames


def test_round_trips_none_state():
    frames = [Frame("school-mon", None)]
    assert decode(encode(frames), "school-mon") == frames


def test_round_trips_an_empty_string_state():
    frames = [Frame("school", "")]
    decoded = decode(encode(frames), "school")
    assert decoded[0].state == ""
    assert decoded[0].state is not None


def test_state_containing_newlines_survives():
    frames = [Frame("school", "STEP LSTS\nWIP 16\nWIPC -")]
    assert decode(encode(frames), "school")[0].state == "STEP LSTS\nWIP 16\nWIPC -"


def test_none_starts_a_fresh_stack():
    assert decode(None, "school-mon") == [Frame("school-mon", None)]


def test_empty_string_starts_a_fresh_stack():
    assert decode("", "school-mon") == [Frame("school-mon", None)]


def test_unrecognised_blob_starts_a_fresh_stack():
    # A session stored before this format existed, or a corrupt row: start
    # clean rather than raising into the websocket loop.
    assert decode("PHASE MENU\nACCT 20,10", "school-mon") == [Frame("school-mon", None)]


def test_json_valid_but_not_dict_starts_a_fresh_stack():
    # json.loads succeeds for null, numbers, strings, arrays. Ensure they all
    # gracefully reset rather than raising AttributeError into the websocket.
    assert decode("null", "school-mon") == [Frame("school-mon", None)]
    assert decode("42", "school-mon") == [Frame("school-mon", None)]
    assert decode('[]', "school-mon") == [Frame("school-mon", None)]
    assert decode('"string"', "school-mon") == [Frame("school-mon", None)]
